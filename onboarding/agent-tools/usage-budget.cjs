#!/usr/bin/env node
// usage-budget.cjs -- print Claude / Codex quota meters for the in-app agent.
// Reads the app's per-boot endpoint file ({url, token}) and GETs it. Path
// contract: $SCHEHERAZADE_USAGE_ENDPOINT, else <data-home>/.usage-endpoint.json
// (--data-home <dir>, else cwd -- the agent's cwd IS the data home).
'use strict'
const fs = require('node:fs')
const path = require('node:path')

function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null }
const epPath = process.env.SCHEHERAZADE_USAGE_ENDPOINT
  || path.join(arg('--data-home') || process.cwd(), '.usage-endpoint.json')

const pct = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n)}%` : '?')
function inDur(iso, now) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  let m = Math.max(0, Math.round((t - now) / 60000))
  const d = Math.floor(m / 1440); m -= d * 1440
  const h = Math.floor(m / 60)
  return d > 0 ? `in ${d}d ${h}h` : (h > 0 ? `in ${h}h ${m % 60}m` : `in ${m}m`)
}
function localTime(iso) {
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? 'unknown' : t.toLocaleString('en-GB', { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function winName(secs, fallback) {
  if (!Number.isFinite(secs) || secs <= 0) return fallback
  return secs >= 6 * 86400 ? 'weekly' : (secs <= 6 * 3600 ? '5h' : `${Math.round(secs / 3600)}h`)
}
function line(label, fiveH, weekly, now) {
  const an = (fiveH && fiveH.name) || '5h'
  const bn = (weekly && weekly.name) || 'weekly'
  const a = fiveH ? `${an}: ${pct(fiveH.pct)} (resets ${fiveH.at ? localTime(fiveH.at) : 'unknown'})` : `${an}: n/a`
  const b = weekly ? `${bn}: ${pct(weekly.pct)} (resets ${weekly.at ? inDur(weekly.at, now) : 'unknown'})` : `${bn}: n/a`
  return `${label} ${a} / ${b}`
}

async function main() {
  let ep
  try { ep = JSON.parse(fs.readFileSync(epPath, 'utf8')) } catch {
    console.log(`Usage: unknown -- no endpoint file at ${epPath} (is the Scheherazade app running?)`)
    process.exit(1)
  }
  let body
  try {
    const res = await fetch(ep.url, { headers: { Authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(15000) })
    body = await res.json()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  } catch (err) {
    console.log(`Usage: unknown -- endpoint unreachable (${err.message}); the app may have restarted, retry once`)
    process.exit(1)
  }
  const now = Date.now()
  const out = []
  const c = body.claude || {}
  if (c.ok) {
    out.push(line('Claude', { pct: c.fiveHourPct, at: c.fiveHourResetsAt }, { pct: c.weeklyPct, at: c.weeklyResetsAt }, now) + (c.stale ? ' [stale]' : ''))
  } else if (c.branch === 'no_token' || c.branch === 'token_unreadable') {
    out.push('Claude usage: unknown -- the user has to run the Claude usage login in Settings once')
  } else {
    out.push(`Claude usage: unavailable (${c.branch || 'error'})`)
  }
  const x = body.codex || {}
  if (x.ok) {
    const w = (v, d) => (v ? { pct: v.usedPct, at: v.resetsAt, name: winName(v.windowSeconds, d) } : null)
    out.push(line('Codex', w(x.primary, '5h'), w(x.secondary, 'weekly'), now) + (x.stale ? ' [stale]' : ''))
  } else if (x.branch === 'no_token') {
    out.push('Codex usage: unknown -- no Codex login')
  } else {
    out.push(`Codex usage: unavailable (${x.branch || 'error'})`)
  }
  const o = body.ollama || {}
  if (o.ok) out.push('Ollama: usage meter available in Settings (no budget rule applies)')
  console.log(out.join('\n'))
}
main()
