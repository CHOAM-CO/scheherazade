'use strict'
// Diagnostic audio only: disk failures must never interrupt recognition.
const fs = require('node:fs/promises')
const path = require('node:path')
const active = new Set()
let rotation = Promise.resolve()

function wavHeader(bytes) {
  if (bytes > 0xffffffff - 36) throw new Error('STT dump exceeds WAV size limit')
  const h = Buffer.alloc(44)
  h.write('RIFF'); h.writeUInt32LE(36 + bytes, 4); h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28)
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(bytes, 40)
  return h
}
function pcm16(pcm) {
  const out = Buffer.alloc(pcm.length / 2)
  for (let i = 0; i < pcm.length / 4; i++) {
    const f = pcm.readFloatLE(i * 4)
    const v = Number.isNaN(f) ? 0 : Math.max(-1, Math.min(1, f))
    out.writeInt16LE(Math.round(v * (v < 0 ? 32768 : 32767)), i * 2)
  }
  return out
}
async function writeWav(raw, wav) {
  const input = await fs.open(raw, 'r')
  let output
  try {
    const { size } = await input.stat()
    if (size % 4) throw new Error('STT dump has incomplete Float32 sample')
    const header = wavHeader(size / 2)
    output = await fs.open(wav, 'wx')
    await output.writeFile(header)
    // Bounded conversion memory, including for long sessions.
    const buffer = Buffer.alloc(64 * 1024)
    for (let offset = 0; offset < size;) {
      const length = Math.min(buffer.length, size - offset)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await input.read(buffer, filled, length - filled, offset + filled)
        if (!bytesRead) throw new Error('STT dump truncated during conversion')
        filled += bytesRead
      }
      await output.writeFile(pcm16(buffer.subarray(0, length)))
      offset += length
    }
  } finally { await input.close(); await output?.close() }
}
function rotate(dir, keep = 50) {
  const work = rotation.then(async () => {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const files = entries.filter(e => e.isFile() && /^\d{4}-\d{2}-\d{2}T[\d.-]+Z-[a-zA-Z0-9_-]+\.(wav|f32)$/.test(e.name))
      .map(e => path.join(dir, e.name)).filter(f => !active.has(f)).sort().reverse()
    for (const file of files.slice(keep)) await fs.unlink(file)
  })
  rotation = work.catch(() => {})
  return work
}
function createDump(dir, sid, log = console.warn) {
  const stem = `${new Date().toISOString().replace(/:/g, '-')}-${String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const raw = path.join(dir, stem + '.f32'), wav = path.join(dir, stem + '.wav')
  active.add(raw); active.add(wav)
  let failed = false, closed = false, queued = 0
  const report = e => { failed = true; log?.(`[stt dump] ${e.message}`) }
  let queue = Promise.resolve().then(async () => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(raw, Buffer.alloc(0), { flag: 'wx' }) }).catch(report)
  return {
    append(pcm) {
      if (closed || failed) return
      // A stalled disk must not retain unbounded microphone buffers.
      if (queued + pcm.length > 8 * 1024 * 1024) { report(new Error('disk queue full; diagnostic capture stopped')); return }
      queued += pcm.length
      queue = queue.then(async () => { if (!failed) await fs.appendFile(raw, pcm) }).catch(report).finally(() => { queued -= pcm.length })
    },
    close() {
      if (closed) return queue
      closed = true
      queue = queue.then(async () => {
        if (!failed) { await writeWav(raw, wav); await fs.unlink(raw) }
      }).catch(report).finally(async () => {
        active.delete(raw); active.delete(wav)
        await rotate(dir).catch(report)
      })
      return queue
    },
  }
}
module.exports = { wavHeader, pcm16, writeWav, rotate, createDump }
