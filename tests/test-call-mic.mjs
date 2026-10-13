import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url), tick = () => new Promise(r => setImmediate(r))
const posts = [], uploads = [], events = [], nodes = [], tracks = []
const input = { value: '', classList: { toggle() {} }, dispatchEvent() {}, focus() {}, setSelectionRange() {} }
const win = {
  SeraSTTCore: require('../onboarding/public/js/stt-core.cjs'), SeraCallCore: require('../onboarding/public/js/call-core.cjs'),
  SeraCall: { active: true, micMuted: false, speaking: false, final: t => events.push(['final', t]), partial: t => events.push(['partial', t]) },
  api: async (url, opts) => { if (opts) posts.push({ url, body: JSON.parse(opts.body) }); return url === '/api/stt/start' ? { sid: 'session-' + posts.length } : { enabled: true, modelsPresent: true } },
}
class Context {
  sampleRate = 16000
  destination = {}
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  createScriptProcessor() { const n = { connect() {}, disconnect() {} }; nodes.push(n); return n }
  close() { return Promise.resolve() }
}
vm.runInNewContext(fs.readFileSync(new URL('../onboarding/public/js/stt.js', import.meta.url), 'utf8'), {
  window: win, document: { documentElement: { lang: 'ko' }, head: { appendChild() {} },
    getElementById: id => id === 'ct-input' ? input : null, querySelector: () => ({ insertBefore() {} }),
    createElement: () => ({ dataset: {}, setAttribute() {} }), addEventListener() {} },
  navigator: { mediaDevices: { async getUserMedia() { const t = { stop() { this.stopped = true } }; tracks.push(t); return { getTracks: () => [t] } } } },
  AudioContext: Context, Blob, URL, Float32Array, Event, AbortSignal, console, setInterval() {},
  fetch: async (url, opts) => { uploads.push({ url, opts }); return { ok: true, json: async () => ({ finals: ['finished'], partial: 'new speech' }) } },
})
const frame = () => nodes.at(-1).onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.1) } })
await win.SeraSTT.start(); frame(); await tick()
assert.equal(posts.find(p => p.url === '/api/stt/start').body.callMode, true)
assert.equal(uploads.length, 1)
assert.deepEqual(events, [['final', 'finished'], ['partial', 'new speech']], 'new partial must suspend the deadline after older finals')
win.SeraCall.micMuted = true; frame(); await tick()
assert.equal(uploads.length, 1, 'muted frame never reaches /api/stt/audio')
win.SeraSTT.cancel(); frame(); await tick()
assert.equal(tracks[0].stopped, true); assert.equal(win.SeraSTT.mode, 'idle')
assert.equal(uploads.length, 1, 'cancelled capture never sends more audio')
assert.ok(posts.some(p => p.url === '/api/stt/stop' && p.body.cancel))
win.SeraCall.micMuted = false; await win.SeraSTT.start(); frame(); await tick()
assert.equal(uploads.length, 2, 'unmute uses a new session and resumes transport')
win.SeraSTT.cancel(); win.SeraCall.active = false
await win.SeraSTT.start(); frame(); await tick()
assert.equal(posts.filter(p => p.url === '/api/stt/start').at(-1).body.callMode, false)
assert.equal(events.length, 4, 'dictation never publishes a call turn')
win.SeraSTT.cancel()
console.log('STT renderer: call profile, final/partial ordering, zero muted uploads, capture cancellation, resume and dictation isolation passed')
