import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { endpointConfig } = require('../onboarding/stt/endpoint.cjs')
assert.deepEqual(endpointConfig(), { rule1MinTrailingSilence: 2.4, rule2MinTrailingSilence: 1.2, rule3MinUtteranceLength: 20 })
assert.deepEqual(endpointConfig(true), { rule1MinTrailingSilence: 3.6, rule2MinTrailingSilence: 1.8, rule3MinUtteranceLength: 12 })
assert.deepEqual(endpointConfig('true'), endpointConfig())
// Execute the actual worker with a fake native recognizer, not source assertions.
const instances = [], output = []; let handler
class Recognizer {
  constructor(config) { this.config = config; instances.push(this) }
  createStream() { return { owner: this, acceptWaveform() {}, inputFinished() {} } }
  isReady(s) { assert.equal(s.owner, this); return false }
  getResult(s) { assert.equal(s.owner, this); return { text: 'words' } }
  isEndpoint() { return true }
  reset() {}
}
let source = fs.readFileSync(new URL('../onboarding/stt/stt-worker.mjs', import.meta.url), 'utf8')
source = source.replace(/^import .*\n/gm, '').replace('const require = createRequire(import.meta.url)', '')
vm.runInNewContext(source, { path: require('node:path'), Float32Array,
  require: id => id === 'sherpa-onnx-node' ? { OnlineRecognizer: Recognizer } : require('../onboarding/stt/' + id.replace('./', '')),
  process: { argv: ['node', 'worker', '/models', '2', '174m'], send: m => output.push(m), on(event, fn) { if (event === 'message') handler = fn } } })
handler({ op: 'load', id: 1, callMode: true }); handler({ op: 'start', sid: 'call', callMode: true })
assert.equal(instances.length, 1, 'call-only use loads one model')
handler({ op: 'start', sid: 'dictation' })
assert.equal(instances.length, 2)
assert.equal(instances[0].config.rule2MinTrailingSilence, 1.8)
assert.equal(instances[1].config.rule2MinTrailingSilence, 1.2)
for (const sid of ['call', 'dictation']) handler({ op: 'audio', sid, pcm: new Float32Array(1600) })
assert.equal(output.filter(m => m.type === 'final').length, 2)
console.log('call endpoint profiles, native config wiring and concurrent stream isolation passed')
