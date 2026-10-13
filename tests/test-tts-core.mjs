#!/usr/bin/env node
// test-tts-core.mjs -- read-aloud text cleaner + serial speech queue (tts-core.cjs),
// plus the model download path against a fake fetch (sha check, .part, progress).
// Run: node tests/test-tts-core.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'package.json'))
const { cleanForSpeech, createSpeechQueue, MAX_CHARS } = req(path.join(ROOT, 'onboarding/public/js/tts-core.cjs'))
const models = req(path.join(ROOT, 'onboarding/tts/models.cjs'))
const manifest = req(path.join(ROOT, 'onboarding/tts/manifest.cjs'))

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

// cleaner
ok(cleanForSpeech('**안녕**, 나 _세라_야.') === '안녕, 나 세라야.', 'emphasis stripped')
ok(cleanForSpeech('보자.\n```js\nconst x = 1\n```\n끝.') === '보자. 끝.', 'fenced code dropped')
ok(cleanForSpeech('열린 코드 ```bash\nrm -rf x') === '열린 코드', 'unclosed fence dropped')
ok(cleanForSpeech('# 제목\n- 하나\n- 둘\n> 인용') === '제목 하나 둘 인용', 'headings/lists/quotes')
ok(cleanForSpeech('[문서](https://x.y/z) 봐 https://a.b/c') === '문서 봐', 'links -> labels, bare urls gone')
ok(cleanForSpeech('`npm test` 돌려') === 'npm test 돌려', 'short inline code kept')
ok(cleanForSpeech('`fs.readFileSync(path.join(a,b))` 써') === '써', 'code-like inline dropped')
ok(cleanForSpeech('| a | b |\n|---|---|\n| 1 | 2 |\n표 끝') === '표 끝', 'table rows dropped')
ok(cleanForSpeech('```\n{"x":1}\n```') === '', 'pure tool/code dump -> empty (skipped)')
ok(cleanForSpeech('12345 ---') === '', 'no letters -> empty')
ok(cleanForSpeech(null) === '', 'non-string -> empty')
const long = 'Sentence number one is here. '.repeat(60)
const cut = cleanForSpeech(long)
ok(cut.length <= MAX_CHARS && cut.endsWith('.'), `capped at sentence boundary (${cut.length})`)
ok(cleanForSpeech('가'.repeat(900)).length === MAX_CHARS, 'hard cap without boundary')

// queue
{
  const log = []
  const q = createSpeechQueue({
    synth: async t => { log.push(`s:${t}`); await new Promise(r => setTimeout(r, 5)); return t },
    play: async p => { log.push(`p+${p}`); await new Promise(r => setTimeout(r, 10)); log.push(`p-${p}`) },
  })
  q.enqueue('a'); q.enqueue('b'); q.enqueue(''); q.enqueue('c')
  await new Promise(r => setTimeout(r, 120))
  ok(log.join(',') === 's:a,p+a,p-a,s:b,p+b,p-b,s:c,p+c,p-c', `serial, no overlap, empty skipped (${log.join(',')})`)
  ok(!q.running && q.size === 0, 'idle after drain')
}
{
  const played = []
  let stopped = 0
  let release
  const q = createSpeechQueue({
    synth: async t => t,
    play: p => new Promise(r => { played.push(p); release = r }),
    stopPlayback: () => { stopped++; release?.() },
  })
  q.enqueue('x'); q.enqueue('y'); q.enqueue('z')
  await new Promise(r => setTimeout(r, 5))
  q.stop()
  await new Promise(r => setTimeout(r, 20))
  ok(played.join() === 'x' && stopped === 1 && !q.running, `stop drops pending + aborts current (${played})`)
  q.enqueue('w'); await new Promise(r => setTimeout(r, 5)); release()
  await new Promise(r => setTimeout(r, 5))
  ok(played.join() === 'x,w', 'queue usable after stop')
}
{
  const states = []
  const q = createSpeechQueue({ synth: async () => { throw new Error('boom') }, play: async () => {}, onState: (s) => states.push(s) })
  q.enqueue('a'); await new Promise(r => setTimeout(r, 10))
  ok(states.join() === 'playing,error,idle', `synth error reported, queue recovers (${states})`)
}

// download path (fake fetch; tiny fake manifest swapped in-place)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-tts-'))
  const good = Buffer.from('hello-weights')
  const saved = manifest.FILES.splice(0, manifest.FILES.length,
    { rel: 'onnx/a.onnx', url: 'https://fake.invalid/a.onnx', size: good.length, sha256: crypto.createHash('sha256').update(good).digest('hex') })
  const fakeFetch = body => async () => ({ ok: true, status: 200, body: (async function* () { yield body.subarray(0, 5); yield body.subarray(5) })() })
  ok(!models.modelsPresent(dir), 'missing before download')
  let bad = null
  try { await models.ensureModels(dir, { fetchImpl: fakeFetch(Buffer.from('tampered-wts!')) }) } catch (e) { bad = e.message }
  ok(/sha256 mismatch/.test(bad || '') && !fs.existsSync(path.join(dir, 'onnx/a.onnx')) && !fs.existsSync(path.join(dir, 'onnx/a.onnx.part')), 'sha mismatch rejected, nothing left behind')
  const prog = []
  await models.ensureModels(dir, { fetchImpl: fakeFetch(good), onProgress: p => prog.push(p.done) })
  ok(models.modelsPresent(dir) && fs.readFileSync(path.join(dir, 'onnx/a.onnx')).equals(good), 'downloaded + verified')
  ok(prog.includes(5) && prog.at(-1) === good.length, `progress reported (${prog})`)
  manifest.FILES.splice(0, manifest.FILES.length, ...saved)
  fs.rmSync(dir, { recursive: true, force: true })
}
ok(manifest.FILES.length === 1 && manifest.TOTAL_BYTES === 226210253 && /^[0-9a-f]{64}$/.test(manifest.FILES[0].sha256) && manifest.FILES[0].url, `manifest intact (${manifest.TOTAL_BYTES} bytes)`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
