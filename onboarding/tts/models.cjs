'use strict'
// Model presence + first-enable download (sha256-checked, resumable by refetch).
// Idempotent: a file whose size matches is trusted (full sha check happens right
// after its download); a size mismatch or a leftover .part is refetched.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { FILES } = require('./manifest.cjs')

function missingFiles(dir) {
  return FILES.filter(f => {
    try { return fs.statSync(path.join(dir, f.rel)).size !== f.size } catch { return true }
  })
}
function modelsPresent(dir) { return missingFiles(dir).length === 0 }

async function downloadOne(f, dir, onBytes, fetchImpl) {
  const dest = path.join(dir, f.rel)
  const part = `${dest}.part`
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetchImpl(f.url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`download ${f.rel}: HTTP ${res.status}`)
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(part)
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r))
      onBytes(chunk.length)
    }
  } finally { await new Promise(r => out.end(r)) }
  const got = hash.digest('hex')
  if (got !== f.sha256) { try { fs.unlinkSync(part) } catch {} ; throw new Error(`sha256 mismatch for ${f.rel}`) }
  fs.renameSync(part, dest)
}

// onProgress({ done, total, file }) -- bytes, across the whole set.
async function ensureModels(dir, { onProgress = () => {}, fetchImpl = fetch } = {}) {
  const missing = missingFiles(dir)
  const TOTAL_BYTES = FILES.reduce((n, f) => n + f.size, 0)
  let done = TOTAL_BYTES - missing.reduce((n, f) => n + f.size, 0)
  onProgress({ done, total: TOTAL_BYTES, file: null })
  for (const f of missing) {
    let fileBytes = 0
    await downloadOne(f, dir, n => { fileBytes += n; onProgress({ done: done + fileBytes, total: TOTAL_BYTES, file: f.rel }) }, fetchImpl)
    done += f.size
  }
  onProgress({ done: TOTAL_BYTES, total: TOTAL_BYTES, file: null })
  return dir
}

module.exports = { ensureModels, modelsPresent, missingFiles }
