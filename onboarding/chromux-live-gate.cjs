#!/usr/bin/env node
'use strict'
// Live-Chrome launcher gate. One switch: BROWSE_LIVE in .agent-config.
// Off -> exit 4, nothing runs. On -> every verb runs (Mino 2026-10-07 15:24:
// no per-action "ask" mode, no session consent). `--ask` is kept as a no-op
// for callers written against the old flow: it answers "go ahead" and exits 0
// without writing any consent file, so an old skill text still converges on
// retrying the real argv.
// History: the per-action / session consent files (chromux-live-consent.cjs)
// were keyed on DATA_HOME/consent/app-boot-id, which http-server.cjs rewrote
// at module load -- every test or tool that required http-server.cjs without
// AGENT_DATA_HOME rotated the live app's boot id and silently voided the
// user's session grant (exit 3 one minute after it was given, 10-07 15:19).
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
function enabled(home) {
  try { return /^BROWSE_LIVE=(?:"true"|true)\r?$/m.test(fs.readFileSync(path.join(home, '.agent-config'), 'utf8').replace(/^﻿/, '')) } catch { return false }
}
function gate({ home, entry, argv, channel, execute = (args) => spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit', env: { ...process.env, CHROMUX_PROFILE: 'live' } }).status ?? 1 }) {
  if (!enabled(home)) return 4
  if (argv[0] === '--channel') { channel = argv[1]; argv = argv.slice(2) }
  if (!channel || !argv.length) return 3
  if (argv[0] === '--ask') {
    try { argv = JSON.parse(argv[1]); if (!Array.isArray(argv) || !argv.length || argv.some(x => typeof x !== 'string')) return 3 } catch { return 3 }
    console.log('Browse with me is on: no consent needed, run the command directly.')
    return 0
  }
  return execute(argv)
}
module.exports = { gate, enabled }
if (require.main === module) {
  const [home, entry, ...argv] = process.argv.slice(2)
  const code = gate({ home, entry, argv, channel: process.env.SCHZ_CHANNEL_ID })
  if (code === 3) console.error('usage: chromux-live --channel <id> <verb> ...')
  if (code === 4) console.error('Browse with me (live Chrome) is OFF')
  process.exitCode = code
}
