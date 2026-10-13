'use strict'
// Model presence + first-enable download for speech-to-text. Same contract as
// tts/models.cjs (sha256-checked, .part file, byte progress), but the asset is
// one .tar.gz: it is verified as a whole, then unpacked in-process (zlib + a
// minimal ustar reader, no tar binary or npm dependency, same on every OS) and
// each extracted file is checked against its own pinned sha256 before rename.
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { getModel } = require('./manifest.cjs')

function missingFiles(dir, modelId = '72m') {
  return getModel(modelId).FILES.filter(f => {
    try { return fs.statSync(path.join(dir, f.rel)).size !== f.size } catch { return true }
  })
}
function modelsPresent(dir, modelId = '72m') { return missingFiles(dir, modelId).length === 0 }

// Minimal ustar/GNU tar reader: regular files only, returns [{ name, data }].
// Directory and metadata entries (pax headers, ._ AppleDouble files) are skipped.
function untar(buf) {
  const out = []
  let o = 0
  let longName = null
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512)
    if (h.every(b => b === 0)) break
    const str = (a, n) => { const s = h.subarray(a, a + n); const z = s.indexOf(0); return s.subarray(0, z < 0 ? n : z).toString('utf8') }
    let name = str(0, 100)
    const prefix = h.subarray(257, 262).toString('ascii') === 'ustar' ? str(345, 155) : ''
    if (prefix) name = `${prefix}/${name}`
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(h[156] || 48)
    const data = buf.subarray(o + 512, o + 512 + size)
    o += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue }
    if (longName) { name = longName; longName = null }
    if (type === '0' || type === '\0') out.push({ name, data })
  }
  return out
}

async function fetchVerified(url, dest, { size, sha256 }, onBytes, fetchImpl) {
  const part = `${dest}.part`
  const res = await fetchImpl(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download ${path.basename(dest)}: HTTP ${res.status}`)
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(part)
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
      onBytes(chunk.length)
    }
  } finally { await new Promise(r => out.end(r)) }
  if (hash.digest('hex') !== sha256 || fs.statSync(part).size !== size) { try { fs.unlinkSync(part) } catch {} ; throw new Error(`sha256 mismatch for ${path.basename(dest)}`) }
  return part
}

// Writes the pinned FILES found in a tar(.gz) buffer into dir, sha-checked.
function extractModels(archive, dir, modelId = '72m') {
  const { FILES } = getModel(modelId)
  const entries = untar(archive[0] === 0x1f && archive[1] === 0x8b ? zlib.gunzipSync(archive) : archive)
  const byBase = new Map(entries.map(e => [path.posix.basename(e.name), e.data]))
  for (const f of FILES) {
    const data = byBase.get(f.rel)
    if (!data) throw new Error(`archive is missing ${f.rel}`)
    if (data.length !== f.size || crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error(`sha256 mismatch for ${f.rel}`)
    const dest = path.join(dir, f.rel)
    fs.writeFileSync(`${dest}.part`, data)
    fs.renameSync(`${dest}.part`, dest)
  }
}

// onProgress({ done, total, file }) -- archive bytes.
async function ensureModels(dir, { onProgress = () => {}, fetchImpl = fetch, modelId = '72m' } = {}) {
  const { ARCHIVE } = getModel(modelId)
  const total = ARCHIVE.size
  if (modelsPresent(dir, modelId)) { onProgress({ done: total, total, file: null }); return dir }
  fs.mkdirSync(dir, { recursive: true })
  let done = 0
  onProgress({ done, total, file: ARCHIVE.name })
  const part = await fetchVerified(ARCHIVE.url, path.join(dir, ARCHIVE.name), ARCHIVE, n => { done += n; onProgress({ done, total, file: ARCHIVE.name }) }, fetchImpl)
  try { extractModels(fs.readFileSync(part), dir, modelId) } finally { try { fs.unlinkSync(part) } catch {} }
  onProgress({ done: total, total, file: null })
  return dir
}

module.exports = { ensureModels, modelsPresent, missingFiles, extractModels, untar }
