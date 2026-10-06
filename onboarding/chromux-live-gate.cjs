#!/usr/bin/env node
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { TTL, key, location, classify } = require('./chromux-live-consent.cjs')
function gate({ home, entry, argv, channel, now = Date.now(), execute = (args) => spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', env: { ...process.env, CHROMUX_PROFILE: 'live' } }).status ?? 1 }) {
  let enabled = false
  try { enabled = /^BROWSE_LIVE=(?:"true"|true)$/m.test(fs.readFileSync(path.join(home, '.agent-config'), 'utf8')) } catch {}
  if (!enabled) return 4
  if (argv[0] === '--channel') { channel = argv[1]; argv = argv.slice(2) }
  if (!channel || !argv.length) return 3
  fs.mkdirSync(path.join(home, 'consent'), { recursive: true, mode: 0o700 })
  if (argv[0] === '--ask') {
    try { argv = JSON.parse(argv[1]); if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string')) return 3 } catch { return 3 }
    const pending = path.join(home, 'consent', 'pending-' + key(channel, []) + '.json')
    // A fresh request invalidates any previously granted identical operation.
    try { fs.unlinkSync(location(home, channel, argv)) } catch {}
    fs.writeFileSync(pending, JSON.stringify({ argv, target: argv[1], askedAt: now }), { mode: 0o600 })
    console.log(`이 페이지에서 ${JSON.stringify(argv).replace(/[\r\n]/g, ' ')} 실행해도 돼?`)
    return 0
  }
  if (classify(argv) === 'write') {
    const file = location(home, channel, argv)
    let consent
    try { consent = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file) } catch { return 3 }
    if (consent.channel !== channel || JSON.stringify(consent.argv) !== JSON.stringify(argv) || now - consent.issuedAt > TTL || now < consent.issuedAt || now - consent.askedAt > TTL) return 3
  }
  return execute(argv)
}
module.exports = { gate }
if (require.main === module) {
  const [home, entry, ...argv] = process.argv.slice(2)
  const code = gate({ home, entry, argv, channel: process.env.SCHZ_CHANNEL_ID })
  if (code === 3) console.error('needs user consent: ask in channel, then retry the same command')
  if (code === 4) console.error('Browse with me (live Chrome) is OFF')
  process.exitCode = code
}
