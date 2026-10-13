import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const source = fs.readFileSync(process.env.CALL_RENDERER_SOURCE || new URL('../onboarding/public/js/call.js', import.meta.url), 'utf8')
const tick = () => new Promise(r => setImmediate(r))
async function fixture({ failMic = false } = {}) {
  const timers = [], spoken = [], elements = new Map(), messages = []
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, lang: 'ko', textContent: '', setAttribute(k,v) { this[k] = v }, getAttribute(k) { return this[k] }, after() {}, append() {}, before() {} })
    return elements.get(id)
  }
  let mode = 'idle', payload = { latest: 0, items: [], draft: '' }, enabled = true
  const audios = []; let now = 1000
  const win = {
    SeraCallCore: require('../onboarding/public/js/call-core.cjs'),
    SeraTTSCore: { cleanForSpeech: require('../onboarding/public/js/tts-core.cjs').cleanForSpeech, createSpeechQueue: require('../onboarding/public/js/tts-core.cjs').createSpeechQueue },
    SeraSTT: { get mode() { return mode }, async start() { mode = failMic ? 'idle' : 'listening' }, cancel() { mode = 'idle' } },
    getOnboardToken: () => '', addEventListener() {}, showToast: x => messages.push(x),
    api: async (url, opts) => { if (url === '/api/call') { if (opts) enabled = JSON.parse(opts.body).enabled; return { enabled, allowed: true } }; if (url.startsWith('/api/chat/out')) return payload; return {} },
  }
  vm.runInNewContext(source, { window: win, document: { documentElement: { lang: 'ko' }, getElementById: id => id === 'set-about' ? null : element(id), createElement: () => element('created'), addEventListener() {} },
    BroadcastChannel: class { postMessage() {} }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    Date: { now: () => now }, AbortSignal, console, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async (_url, opts) => { spoken.push(JSON.parse(opts.body).text); return { ok: true, blob: async () => ({}) } },
    Audio: class { constructor() { this.paused = false; this.ended = false; this.duration = 2; audios.push(this) }; play() { this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve() }; pause() { this.paused = true; this.onpause?.() } },
  })
  await tick(); await tick()
  return { win, timers, spoken, audios, messages, element, setPayload: p => { payload = p }, advance: ms => { now += ms }, async run(ms) { for (const t of timers.filter(t => t.ms === ms)) await t.fn(); await tick(); await tick() } }
}
// B2 must never claim active after a failed open.
if (!process.env.CALL_CASE || process.env.CALL_CASE === 'B2') { const failed = await fixture({ failMic: true }); assert.equal(failed.win.SeraCall.active, false) }
// B1: interruption must not speak later draft sentences.
if (!process.env.CALL_CASE || process.env.CALL_CASE === 'B1') {
const f = await fixture(); await f.run(250)
f.setPayload({ latest: 0, items: [], draft: '첫 문장. 다음' }); await f.run(250)
f.win.SeraCall.partial('사용자'); f.setPayload({ latest: 0, items: [], draft: '첫 문장. 다음 문장. ' }); await f.run(250)
assert.equal(f.spoken.length, 1)
}
// B3: lost ended event cannot suppress recognition past the hard timeout.
if (!process.env.CALL_CASE || process.env.CALL_CASE === 'B3') {
const stalled = await fixture(); await stalled.run(250)
stalled.setPayload({ latest: 0, items: [], draft: '읽어주세요. ' }); await stalled.run(250)
assert.equal(stalled.win.SeraCall.speaking, true)
stalled.advance(121000); await stalled.run(250); stalled.advance(301); await stalled.run(250)
assert.equal(stalled.win.SeraCall.speaking, false)
}
console.log('renderer regressions: failed mic off, abandoned draft and lost ended watchdog passed')

// A short stall is not an ended segment, even near the duration watchdog.
const resume = await fixture(); await resume.run(250)
resume.setPayload({ latest: 0, items: [], draft: '첫 문장. 두 번째. ' }); await resume.run(250)
const clip = resume.audios[0]
resume.advance(7000); clip.onstalled()
resume.advance(7999); await resume.run(250)
assert.equal(resume.spoken.length, 1, 'stall must not advance the queue')
assert.equal(resume.win.SeraCall.speaking, true, 'mic remains suppressed during stall')
clip.oncanplay(); assert.equal(clip.playCalls, 2, 'canplay attempts to resume')
clip.onplaying(); await resume.run(250)
assert.equal(resume.spoken.length, 1, 'resume extends watchdog by time spent stalled')
clip.onended(); await resume.run(250)
assert.equal(resume.spoken.length, 2, 'only ended advances the recovered segment')
assert.equal(clip.onstalled, null, 'finished clips cannot affect later playback')

const timeout = await fixture(); await timeout.run(250)
timeout.setPayload({ latest: 0, items: [], draft: '첫 문장. 두 번째. ' }); await timeout.run(250)
const stuck = timeout.audios[0]
stuck.onstalled(); timeout.advance(4000); stuck.onstalled()
timeout.advance(3999); await timeout.run(250); assert.equal(timeout.spoken.length, 1)
timeout.advance(1); await timeout.run(250)
assert.equal(timeout.spoken.length, 2, 'eight seconds skips a stalled segment; repeated stalls do not reset the deadline')
assert.equal(timeout.win.SeraCall.active, true)
timeout.audios[1].onstalled(); timeout.win.SeraCall.stop()
timeout.advance(9000); await timeout.run(250)
assert.equal(timeout.win.SeraCall.speaking, false, 'hangup clears stalled playback immediately')
assert.equal(timeout.spoken.length, 2)
console.log('renderer stall regression: wait, canplay/playing resume, eight-second skip and hangup passed')
