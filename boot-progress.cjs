// Shared clock across supervisor, lane, engine and MCP children. Never use stdout.
const fs = require('node:fs')
const path = require('node:path')
function bootBoundary(name, phase, home = process.env.MEM || process.env.AGENT_DATA_HOME) {
  const started = Number(process.env.SCHZ_BOOT_STARTED_MS) || Date.now() - process.uptime() * 1000
  const elapsedMs = Math.max(0, Math.round(Date.now() - started))
  process.stderr.write(`[dsh-lane] boot ${name} elapsed_ms=${elapsedMs} pid=${process.pid} process_ms=${Math.round(process.uptime() * 1000)}\n`)
  if (home && phase) {
    try { fs.writeFileSync(path.join(home, `.boot-${phase}.json`), JSON.stringify({ name, phase, elapsedMs, started, at: Date.now() })) } catch {}
  }
}
function readBootProgress(home, since) {
  const start = Date.parse(since)
  const rows = ['memory', 'channels', 'engine', 'ready'].flatMap(phase => {
    try { const row = JSON.parse(fs.readFileSync(path.join(home, `.boot-${phase}.json`), 'utf8')); return row.started >= start - 1000 ? [row] : [] } catch { return [] }
  }).sort((a, b) => b.at - a.at)
  return rows[0] || null
}
module.exports = { bootBoundary, readBootProgress }
