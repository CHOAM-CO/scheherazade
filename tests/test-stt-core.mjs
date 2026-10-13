#!/usr/bin/env node
// test-stt-core.mjs -- voice input pure parts: manifest pinning, the 16 kHz
// downsampler + input composer (stt-core.cjs), the in-process tar reader, and
// the model download path against a fake fetch (sha check, .part cleanup,
// per-file sha check on extract). SERA_STT_ARCHIVE = the real release tarball
// runs the full download+extract path offline against it (skipped if unset).
// Run: node tests/test-stt-core.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const req = createRequire(path.join(ROOT, 'package.json'))
const { createDownsampler, composeText, TARGET_RATE } = req(path.join(ROOT, 'onboarding/public/js/stt-core.cjs'))
const models = req(path.join(ROOT, 'onboarding/stt/models.cjs'))
const manifest = req(path.join(ROOT, 'onboarding/stt/manifest.cjs'))

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

// manifest
const HEX = /^[0-9a-f]{64}$/
ok(manifest.ARCHIVE.url === manifest.SERA_STT_MODEL_URL && manifest.ARCHIVE.url.startsWith('https://github.com/Mino-is-me/scheherazade-releases/releases/download/models-v1/'), 'archive url is the models-v1 release asset')
ok(manifest.ARCHIVE.url.endsWith(manifest.ARCHIVE.name) && HEX.test(manifest.ARCHIVE.sha256) && manifest.ARCHIVE.size === 58590777, 'archive size + full sha256 pinned')
ok(manifest.FILES.length === 4 && manifest.FILES.every(f => HEX.test(f.sha256) && Number.isInteger(f.size) && f.size > 0), 'four files, each with full sha256 + size')
ok([manifest.ENCODER, manifest.DECODER, manifest.JOINER, manifest.TOKENS].every(n => manifest.FILES.some(f => f.rel === n)), 'encoder/decoder/joiner/tokens all pinned')
ok(new Set(manifest.FILES.map(f => f.sha256)).size === 4, 'no duplicated hashes')
ok(manifest.SAMPLE_RATE === 16000 && TARGET_RATE === 16000, '16 kHz on both sides')

// downsampler
{
  const d = createDownsampler(48000)
  const out = d(new Float32Array(4800).fill(0.5))
  ok(out.length === 1600 && out.every(v => Math.abs(v - 0.5) < 1e-6), '48k -> 16k: 100 ms in, 1600 out, DC preserved')
  let n = 0
  const d2 = createDownsampler(44100)
  for (let i = 0; i < 100; i++) n += d2(new Float32Array(441)).length // 1 s in 100 odd-sized chunks
  ok(Math.abs(n - 16000) <= 1, `44.1k -> 16k streamed in chunks: ${n} samples for 1 s (no drift)`)
  const tone = new Float32Array(48000).map((_, i) => Math.sin(2 * Math.PI * 440 * i / 48000))
  const t16 = createDownsampler(48000)(tone)
  let zc = 0
  for (let i = 1; i < t16.length; i++) if ((t16[i - 1] < 0) !== (t16[i] < 0)) zc++
  ok(Math.abs(zc - 880) <= 4, `440 Hz tone keeps its pitch after downsampling (${zc} zero crossings / s)`)
  const nyq = createDownsampler(48000)(new Float32Array(4800).map((_, i) => (i % 2 ? 1 : -1)))
  ok(Math.max(...nyq.map(Math.abs)) < 0.34, '24 kHz content is attenuated (box filter)')
  ok(createDownsampler(16000)(new Float32Array([1, 2, 3])).length === 3, '16k passes through')
  ok(Math.abs(createDownsampler(8000)(new Float32Array(800)).length - 1600) <= 2, '8k is interpolated up to 16k')
  let threw = false
  try { createDownsampler(0) } catch { threw = true }
  ok(threw, 'bad rate throws')
}

// composer
ok(composeText('메모: ', ['안녕'], '세라') === '메모: 안녕 세라', 'base + finals + partial joined')
ok(composeText('', [], '') === '' && composeText('  ', ['', ' x '], '') === 'x', 'empty parts dropped, trimmed')

// tar reader
function tarEntry(name, data, type = '0') {
  const h = Buffer.alloc(512)
  h.write(name.slice(0, 100), 0, 'utf8')
  h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
  h.write('00000000000\0', 136)
  h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263)
  h.fill(' ', 148, 156)
  let sum = 0; for (const b of h) sum += b
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)])
}
const mkTar = entries => Buffer.concat([...entries, Buffer.alloc(1024)])
{
  const long = 'd/' + 'x'.repeat(120) + '.txt'
  const t = mkTar([tarEntry('dir/', Buffer.alloc(0), '5'), tarEntry('./a.txt', Buffer.from('hello')), tarEntry('././@LongLink', Buffer.from(long + '\0'), 'L'), tarEntry('trunc', Buffer.from('long body'))])
  const e = models.untar(t)
  ok(e.length === 2 && e[0].name === './a.txt' && e[0].data.toString() === 'hello', 'untar: regular file read, directory skipped')
  ok(e[1].name === long && e[1].data.toString() === 'long body', 'untar: GNU long name honoured')
}

// download path with a fake fetch
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sera-stt-core-'))
const fakeFetch = buf => async () => ({ ok: true, status: 200, body: (async function* () { for (let i = 0; i < buf.length; i += 65536) yield buf.subarray(i, i + 65536) })() })
try {
  const bogus = zlib.gzipSync(mkTar([tarEntry('tokens.txt', Buffer.from('nope'))]))
  let err = null
  const dir = path.join(tmp, 'a')
  try { await models.ensureModels(dir, { fetchImpl: fakeFetch(bogus) }) } catch (e) { err = e.message }
  ok(err && /sha256 mismatch/.test(err), `archive sha mismatch rejected (${err})`)
  ok(!fs.readdirSync(dir).some(n => n.endsWith('.part')), 'no .part left behind')
  ok(!models.modelsPresent(dir) && models.missingFiles(dir).length === 4, 'nothing counted as present')
  err = null
  try { models.extractModels(bogus, dir) } catch (e) { err = e.message }
  ok(err && /missing encoder/.test(err), 'extract: archive without the pinned files rejected')
  const tok = manifest.FILES.find(f => f.rel === manifest.TOKENS)
  const fakeAll = zlib.gzipSync(mkTar(manifest.FILES.map(f => tarEntry(f.rel, f === tok ? Buffer.alloc(f.size) : Buffer.alloc(1)))))
  err = null
  try { models.extractModels(fakeAll, dir) } catch (e) { err = e.message }
  ok(err && /sha256 mismatch/.test(err), 'extract: per-file sha256 checked')
  const arch = process.env.SERA_STT_ARCHIVE
  if (!arch || !fs.existsSync(arch)) console.log('  SKIP real archive: set SERA_STT_ARCHIVE')
  else {
    const d2 = path.join(tmp, 'b')
    const seen = []
    await models.ensureModels(d2, { fetchImpl: fakeFetch(fs.readFileSync(arch)), onProgress: p => seen.push(p.done) })
    ok(models.modelsPresent(d2) && fs.readdirSync(d2).sort().join() === manifest.FILES.map(f => f.rel).sort().join(), 'real archive: four files extracted, archive removed')
    ok(seen.at(-1) === manifest.TOTAL_BYTES && seen.every((v, i) => !i || v >= seen[i - 1]), 'progress monotonic, ends at total')
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }) }

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
