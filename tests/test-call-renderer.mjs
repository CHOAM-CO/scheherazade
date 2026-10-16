import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const source = fs.readFileSync(process.env.CALL_RENDERER_SOURCE || new URL('../onboarding/public/js/call.js', import.meta.url), 'utf8')
const tick = () => new Promise(r => setImmediate(r))
async function fixture({ failMic = false, companion = true, toast = true, remote = false, failTTS = false } = {}) {
  const deadlines = new Map(); let timerId = 0, starts = 0, cancels = 0, broadcast
  const broadcasts = []; let heldOut = null
  const timers = [], spoken = [], elements = new Map(), messages = [], bubbleErrors = [], posted = [], keys = []
  function make(id = '') {
    return { classList: { toggle() {} }, appendChild(n) { this.append(n) }, id, children: [], hidden: false, textContent: '', setAttribute(k,v) { this[k] = v }, getAttribute(k) { return this[k] },
      append(...nodes) { for (const n of nodes) { this.children.push(n); n.parent = this } },
      prepend(...nodes) { this.append(...nodes) }, after(n) { this.parent?.append(n) }, before(n) { this.parent?.append(n) } }
  }
  const root = make('root')
  const element = id => elements.get(id) || root.children.flatMap(n => [n, ...n.children, ...n.children.flatMap(c => c.children)]).find(n => n.id === id)
  for (const id of ['ct-status', 'ct-mic', 'ct-quickbar', ...(companion ? ['b-mic', 'bubble', 'caption', 'failure'] : [])]) {
    const el = make(id); elements.set(id, el); root.append(el)
  }
  let mode = 'idle', payload = { latest: 0, items: [], draft: '', state: { awaitingReplySince: null } }, enabled = true, turnError = {}, failPost = false
  const audios = []; let now = 1000
  const win = {
    COPY: { call: require('../onboarding/public/js/call-copy.cjs').ko },
    SeraCallCore: { ...require('../onboarding/public/js/call-core.cjs'), createUtteranceAggregator: opts => require('../onboarding/public/js/call-core.cjs').createUtteranceAggregator({ ...opts, setTimer: (fn, ms) => { deadlines.set(++timerId, { fn, at: now + ms }); return timerId }, clearTimer: id => deadlines.delete(id) }), createSegmentRetry: opts => require('../onboarding/public/js/call-core.cjs').createSegmentRetry({ ...opts, wait: () => Promise.resolve() }) },
    SeraTTSCore: { cleanForSpeech: require('../onboarding/public/js/tts-core.cjs').cleanForSpeech, createSpeechQueue: require('../onboarding/public/js/tts-core.cjs').createSpeechQueue },
    SeraSTT: { get mode() { return mode }, async start() { starts++; mode = failMic ? 'idle' : 'listening' }, cancel() { cancels++; mode = 'idle' } },
    getOnboardToken: () => '', addEventListener() {}, ...(toast ? { showToast: x => messages.push(x) } : {}), SeraCompanionError: x => bubbleErrors.push(x),
    api: async (url, opts) => { if (opts) { posted.push({ url, body: JSON.parse(opts.body) }); if (failPost) throw new Error('request failed') }; if (url === '/api/agent/turn-error') return turnError; if (url === '/api/companion') return { available: remote, enabled: remote, speaking: remote }; if (url === '/api/call') { if (opts) enabled = JSON.parse(opts.body).enabled; return { enabled, allowed: true } }; if (url.startsWith('/api/chat/out')) { if (heldOut) { const held = heldOut; heldOut = null; return held }; return payload }; return {} },
  }
  vm.runInNewContext(source, { window: win, document: { documentElement: { lang: 'ko' }, getElementById: element, createElement: () => make(), addEventListener: (name, fn) => { if (name === 'keydown') keys.push(fn) } },
    BroadcastChannel: class { constructor() { broadcast = this } postMessage(m) { broadcasts.push(m) } }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length }, clearInterval() {}, setTimeout() {}, clearTimeout() {},
    Date: { now: () => now }, AbortSignal, console, URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    fetch: async (_url, opts) => { spoken.push(JSON.parse(opts.body).text); return { ok: !failTTS, status: failTTS ? 503 : 200, blob: async () => ({}) } },
    Audio: class { constructor() { this.paused = false; this.ended = false; this.duration = 2; audios.push(this) }; play() { this.playCalls = (this.playCalls || 0) + 1; return Promise.resolve() }; pause() { this.paused = true; this.onpause?.() } },
  })
  await tick(); await tick()
  return { win, deferOut() { let release; heldOut = new Promise(r => { release = r }); return release }, broadcasts, receive: data => broadcast.onmessage({ data }), get starts() { return starts }, get cancels() { return cancels }, timers, spoken, audios, messages, bubbleErrors, posted, keys, root, element, setError: e => { turnError = e }, failPost: () => { failPost = true }, setPayload: p => { payload = { state: { awaitingReplySince: null }, ...p } }, advance: ms => { now += ms; for (const [id, t] of [...deadlines]) if (t.at <= now && deadlines.delete(id)) t.fn() }, async run(ms) { for (const t of timers.filter(t => t.ms === ms)) await t.fn(); await tick(); await tick() } }
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

for (const companion of [false, true]) {
  const f = await fixture({ companion })
  const panel = f.element('call-controls'), status = f.element('call-state'), end = f.element('call-end')
  assert.ok(panel.parent, 'call controls attached to the document')
  assert.equal(panel.parent.id, companion ? 'bubble' : 'root', 'Face and orb share the visible bubble, not the hidden orb toolbar')
  assert.equal(panel.hidden, false)
  assert.equal(end.textContent, '통화 종료')
  assert.equal(status.textContent, '듣는 중')
  assert.ok(f.element('call-mode').parent, 'call toggle is attached in chat too')
  await f.run(250)
  f.setPayload({ latest: 1, items: [{ role: 'agent', text: '말해 주세요.' }] }); await f.run(250); await f.run(250)
  assert.equal(status.textContent, '말하는 중')
  f.setError({ present: true, fresh: true, subtype: 'retrying' }); await f.run(1000)
  assert.equal(status.textContent, '다시 보내는 중...')
  assert.equal(f.messages.length, 0, 'retry is a quiet status, not a toast')
  f.setError({ present: false }); f.win.SeraCall.stopSpeech(); await f.run(1000)
  assert.equal(status.textContent, '듣는 중')
  end.onclick(); await tick()
  assert.equal(f.win.SeraCall.active, false)
  assert.equal(panel.hidden, true)
  assert.ok(f.posted.some(p => p.url === '/api/call' && p.body.enabled === false))
}
const remote = await fixture({ companion: false, remote: true })
await remote.run(1000)
assert.equal(remote.win.SeraCall.active, false, 'chat does not steal companion mic ownership')
assert.equal(remote.element('call-controls').hidden, false, 'non-owning chat still has hangup')
assert.equal(remote.element('call-state').textContent, '말하는 중')
remote.keys[0]({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} }); await tick()
assert.equal(remote.element('call-controls').hidden, true, 'Esc stops even a non-owning call surface')
for (const toast of [false, true]) {
  const f = await fixture({ toast }); await f.run(250); f.failPost(); f.win.SeraCall.final('전송'); f.advance(1200); await tick()
  assert.deepEqual(toast ? f.messages : f.bubbleErrors, ['request failed'])
  assert.equal((toast ? f.bubbleErrors : f.messages).length, 0)
  const mic = await fixture({ toast, failMic: true })
  assert.equal((toast ? mic.messages : mic.bubbleErrors).length, 1, 'mic errors use the same presenter')
}
console.log('call surfaces: attached chat/Face controls, state transitions, remote ownership, hangup/Esc and error routing passed')

for (const toast of [false, true]) {
  const f = await fixture({ toast, failTTS: true }); await f.run(250)
  for (let seq = 1; seq <= 3; seq++) {
    f.setPayload({ latest: seq, items: [{ role: 'agent', text: `문장 ${seq}.` }] }); await f.run(250)
    if (seq < 3) assert.equal(f.messages.length + f.bubbleErrors.length, 0, 'segment retries stay quiet')
  }
  assert.equal(f.win.SeraCall.active, false)
  assert.deepEqual(toast ? f.messages : f.bubbleErrors, ['TTS 503'], 'exhausted TTS uses the shared presenter')
}
console.log('TTS error routing: retries quiet, exhausted segments stop and alert on both surfaces')

const aggregated = await fixture(); await aggregated.run(250)
aggregated.win.SeraCall.final('첫 구절'); await aggregated.run(250)
assert.equal(aggregated.element('call-state').textContent, '듣는 중...')
aggregated.advance(200)
assert.equal(aggregated.posted.filter(p => p.url === '/api/chat/in').length, 0)
aggregated.win.SeraCall.partial('다음'); aggregated.advance(1500)
assert.equal(aggregated.posted.filter(p => p.url === '/api/chat/in').length, 0)
aggregated.win.SeraCall.final('다음 구절'); aggregated.advance(1200); await tick()
assert.equal(aggregated.posted.find(p => p.url === '/api/chat/in').body.text, '첫 구절 다음 구절')
assert.equal(aggregated.posted.find(p => p.url === '/api/chat/in').body.origin, 'voice')
aggregated.win.SeraCall.final('종료 후 보내면 안 됨'); aggregated.win.SeraCall.stop(); aggregated.advance(15000)
assert.equal(aggregated.posted.filter(p => p.url === '/api/chat/in').length, 1)
console.log('call aggregation: delayed publication, resumed speech merge and hangup cancellation passed')

const pending = await fixture(); await pending.run(250)
const sentTurns = () => pending.posted.filter(p => p.url === '/api/chat/in').map(p => p.body.text)
pending.win.SeraCall.final('sent'); pending.advance(1200); await tick()
pending.setPayload({ latest: 1, items: [], state: { awaitingReplySince: 1000 } }); await pending.run(250)
for (const text of ['older', 'newer']) { pending.win.SeraCall.final(text); pending.advance(1200); await tick() }
assert.deepEqual(sentTurns(), ['sent'], '202 must not release the pending turn')
pending.win.SeraCall.partial('resumed')
pending.setPayload({ latest: 2, items: [], state: { awaitingReplySince: null } }); await pending.run(250)
assert.deepEqual(sentTurns(), ['sent'], 'completion cannot send while new speech is in progress')
pending.win.SeraCall.final('tail'); pending.advance(1200); await tick()
assert.deepEqual(sentTurns(), ['sent', 'older newer tail'])
pending.win.SeraCall.stop()
console.log('renderer turn gate: wait for completion, replace with prepend, and merge resumed speech passed')

for (const companion of [false, true]) {
  const f = await fixture({ companion }); await f.run(250)
  const voice = f.element('call-voice'), mic = f.element('call-mic')
  for (const b of [voice, mic]) {
    assert.equal(b.type, 'button', 'native keyboard activation, not a clickable span')
    assert.equal(b.parent.id, 'call-controls'); assert.equal(b.hidden, false)
    assert.equal(b['aria-pressed'], 'false'); assert.match(b.innerHTML, /mute-slash/)
  }
  f.setPayload({ latest: 1, items: [], draft: '지금 말하는 중. ' }); await f.run(250)
  assert.equal(f.audios.length, 1)
  voice.onclick(); assert.equal(f.audios[0].paused, true)
  assert.equal(voice['aria-pressed'], 'true'); assert.equal(voice['aria-label'], '세라 목소리 켜기')
  f.setPayload({ latest: 2, items: [{ role: 'agent', text: '새 음성은 재생 안 함.' }] }); await f.run(250)
  assert.equal(f.spoken.length, 1)
  voice.onclick()
  f.setPayload({ latest: 3, items: [{ role: 'agent', text: '다시 말해요.' }] }); await f.run(250)
  assert.equal(f.spoken.length, 2)
  mic.onclick(); assert.equal(f.cancels, 2); assert.equal(f.win.SeraCall.micMuted, true)
  assert.equal(f.element('call-state').textContent, '마이크 꺼짐')
  f.win.SeraCall.final('muted final'); f.win.SeraCall.partial('muted partial'); f.advance(15000)
  assert.equal(f.posted.filter(p => p.url === '/api/chat/in').length, 0)
  await f.run(1000); assert.equal(f.win.SeraCall.active, true, 'intentional mute is not mic failure')
  mic.onclick(); await tick(); assert.equal(f.starts, 2); assert.equal(f.win.SeraCall.micMuted, false)
  assert.equal(mic['aria-label'], '내 마이크 끄기')
  voice.onclick(); mic.onclick(); f.win.SeraCall.stop()
  assert.equal(f.win.SeraCall.voiceMuted, false); assert.equal(f.win.SeraCall.micMuted, false)
  assert.ok(f.broadcasts.some(m => m.type === 'call-mutes'))
}
const owner = await fixture()
owner.receive({ type: 'call-mutes', micMuted: true, voiceMuted: true })
assert.equal(owner.win.SeraCall.active, true); assert.equal(owner.cancels, 2)
assert.equal(owner.element('call-state').textContent, '마이크 꺼짐')
owner.win.SeraCall.stop()
console.log('call mute controls: keyboard-native buttons, playback stop/skip/resume, mic cancel/reopen, remote control and call-only reset passed')

const raced = await fixture(); await raced.run(250)
const releaseOldPoll = raced.deferOut(), oldPoll = raced.run(250)
await tick()
raced.win.SeraCall.final('first'); raced.advance(1200); await tick()
releaseOldPoll({ latest: 0, items: [], state: { awaitingReplySince: null } }); await oldPoll
raced.win.SeraCall.final('second'); raced.advance(1200); await tick()
assert.equal(raced.posted.filter(p => p.url === '/api/chat/in').length, 1, 'pre-send idle snapshot cannot release a second turn')
await raced.run(250)
assert.equal(raced.posted.filter(p => p.url === '/api/chat/in').length, 2, 'fresh post-ACK idle snapshot releases pending text')
raced.win.SeraCall.stop()
console.log('turn status race: delayed pre-send idle snapshots cannot release pending turns passed')

const failedHud = await fixture({ failMic: true, toast: false })
const errorBroadcast = failedHud.broadcasts.find(message => message.type === 'call-error')
assert.ok(errorBroadcast, 'call-only HUD errors reach chat before native window closes')
const errorChat = await fixture({ companion: false, remote: true })
errorChat.receive(errorBroadcast)
assert.deepEqual(errorChat.messages, [errorBroadcast.message])
console.log('Call HUD errors retained as chat toasts passed')

const escapeChat = await fixture({ companion: false, remote: true })
const turnStop = { id: 'ct-stop', children: [], hidden: false, dataset: { mode: 'stop' } }
escapeChat.root.append(turnStop)
let consumed = false
const escapeEvent = { key: 'Escape', preventDefault() { consumed = true }, stopImmediatePropagation() { consumed = true } }
escapeChat.keys[0](escapeEvent)
assert.equal(consumed, false, 'running turn Escape must reach chat cancellation handler')
assert.equal(escapeChat.element('call-controls').hidden, false)
turnStop.hidden = true
escapeChat.keys[0](escapeEvent)
assert.equal(consumed, true)
assert.equal(escapeChat.element('call-controls').hidden, true, 'idle Escape ends call')
console.log('Escape prioritizes turn stop before call hangup passed')
