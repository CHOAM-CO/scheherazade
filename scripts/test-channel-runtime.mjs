#!/usr/bin/env node
// test-channel-runtime.mjs -- the drift tripwire for channel-runtime.mjs
// (issue #8). Three backends share one runtime contract; this file is what
// makes re-inlined copies and per-transport drift fail loudly instead of
// accumulating silently. Promises under test:
//   1. channel-runtime.mjs is protocol-neutral: its import list is node:
//      builtins only -- no transport SDK, no package imports at all.
//   2. Every backend consumes the runtime (imports ./channel-runtime.mjs)
//      instead of carrying its own copy of the shared layer.
//   3. All three resolvers return the unified {target, note} shape (discord:
//      channel object / slack: channel id string / telegram: chat object) --
//      never the pre-#8 {ch}/{channelId} keys -- and share the fail-closed
//      OUTBOUND_TARGET_INVALID semantics on an explicit unreachable id.
//   4. Marker writes conform to the ONE base schema (liveness:
//      status/lastHeartbeat/pid; failure: status/reason/code/since/pid) and
//      backend extensions ride ONLY under ext:{...}, never top-level.
//   5. Given the same DATA_HOME, all three backends write the same marker
//      files -- the supervisor polls one contract regardless of transport.
//
// Run: node scripts/test-channel-runtime.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Import-safety convention (mirrors test-outbound-channel.mjs etc.): every
// backend reads its tokens + HOME_CHANNEL_ID at module scope and FATAL-exits
// when missing -- all set to throwaway values BEFORE import; argv[1] stays
// this test's path so each isMainModule guard keeps boot() from running.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-runtime-smoke-'))
process.env.AGENT_DATA_HOME = tmpDir
process.env.DISCORD_BOT_TOKEN = 'test-token-not-real'
process.env.SLACK_BOT_TOKEN = 'xoxb-test-not-real'
process.env.SLACK_APP_TOKEN = 'xapp-test-not-real'
process.env.TELEGRAM_BOT_TOKEN = 'test-token-not-real'
process.env.HOME_CHANNEL_ID = '123456789012345678'
process.env.AGENT_NAME = 'smoketest'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_PATH = path.join(ROOT, 'channel-runtime.mjs')
const BACKENDS = [
  { name: 'discord (channel.mjs)', file: 'channel.mjs', targetKind: 'object' },
  { name: 'slack (channel-slack.mjs)', file: 'channel-slack.mjs', targetKind: 'string' },
  { name: 'telegram (channel-telegram.mjs)', file: 'channel-telegram.mjs', targetKind: 'object' },
]

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.error(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1. runtime purity: node: builtins only ──────────────────────────────────
console.log('channel-runtime purity (zero transport imports)')
{
  const src = fs.readFileSync(RUNTIME_PATH, 'utf8')
  const specifiers = [...src.matchAll(/^\s*import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1])
  check('the import scan found something (an empty scan always passes)', specifiers.length > 0)
  for (const spec of specifiers) {
    check(`import '${spec}' is a node: builtin`, spec.startsWith('node:'), 'transport SDKs / packages are banned in the runtime')
  }
  for (const banned of ["'discord.js'", '@slack/socket-mode', '@slack/web-api', 'dotenv']) {
    check(`no ${banned} anywhere in the runtime source`, !src.includes(banned))
  }
}

// ── 2. every backend consumes the runtime ───────────────────────────────────
console.log('\nbackends import the runtime (no re-inlined copies)')
for (const b of BACKENDS) {
  const src = fs.readFileSync(path.join(ROOT, b.file), 'utf8')
  check(`${b.file} imports ./channel-runtime.mjs`, src.includes("from './channel-runtime.mjs'"))
  check(`${b.file} carries no local console-reroute copy`, !src.includes('console[method]'))
  check(`${b.file} carries no local atomic-write copy`, !src.includes('async function atomicWriteJson'))
}

// ── 3. unified resolver contract: {target, note} + fail-closed ─────────────
console.log('\nresolver contract ({target, note}, all three backends)')
const mods = {}
// pathToFileURL, not a bare path: on Windows `import('C:\\...')` throws
// ERR_UNSUPPORTED_ESM_URL_SCHEME (node reads 'c:' as a protocol). Six tests
// could not run at all on the win box for this (2026-08-04, first full suite
// run there). Production already does this correctly -- it was only the
// harness, which is exactly the safety net the Windows lane needs most.
for (const b of BACKENDS) mods[b.file] = await import(pathToFileURL(path.join(ROOT, b.file)).href)
for (const b of BACKENDS) {
  const { resolveOutboundChannel } = mods[b.file]
  // fetchFn returns the backend-native target kind the contract documents.
  const fetchFn = b.targetKind === 'string'
    ? async (id) => { if (id === 'known') return id; throw new Error(`channel ${id} not found`) }
    : async (id) => { if (id === 'known') return { id }; throw new Error(`channel ${id} not found`) }

  const r = await resolveOutboundChannel('known', { fetchFn, lastId: null, homeId: null })
  const keys = Object.keys(r).sort().join(',')
  check(`${b.name}: resolver returns exactly {target, note}`, keys === 'note,target', `got {${keys}}`)
  check(`${b.name}: no legacy {ch}/{channelId} keys`, !('ch' in r) && !('channelId' in r))
  const targetOk = b.targetKind === 'string' ? r.target === 'known' : r.target?.id === 'known'
  check(`${b.name}: target is the backend-native handle (${b.targetKind})`, targetOk, JSON.stringify(r.target))
  check(`${b.name}: no note on a clean resolve`, r.note === null)

  let err = null
  try {
    await resolveOutboundChannel('bogus', { fetchFn, lastId: 'known', homeId: 'known' })
  } catch (e) { err = e }
  check(`${b.name}: unknown explicit id fails closed even with a fallback`, err !== null)
  check(`${b.name}: error code is OUTBOUND_TARGET_INVALID`, err?.code === 'OUTBOUND_TARGET_INVALID', err?.code)
  check(`${b.name}: error states nothing was sent`, !!err && /nothing was sent/i.test(err.message))
}

// ── 4 + 5. marker base schema + one on-disk contract per DATA_HOME ─────────
console.log('\nmarker schema (base fields + ext rule) and shared paths')
{
  const paths = BACKENDS.map((b) => ({
    live: mods[b.file].LIVENESS_MARKER_PATH,
    fail: mods[b.file].FAILURE_MARKER_PATH,
  }))
  check('all three backends write the SAME liveness marker path', new Set(paths.map((p) => p.live)).size === 1, JSON.stringify(paths.map((p) => p.live)))
  check('all three backends write the SAME failure marker path', new Set(paths.map((p) => p.fail)).size === 1, JSON.stringify(paths.map((p) => p.fail)))
}
for (const b of BACKENDS) {
  const { writeLivenessMarker, writeFailureMarker, LIVENESS_MARKER_PATH, FAILURE_MARKER_PATH } = mods[b.file]

  await writeLivenessMarker()
  const live = JSON.parse(fs.readFileSync(LIVENESS_MARKER_PATH, 'utf8'))
  check(`${b.name}: liveness marker keys are exactly {status, lastHeartbeat, pid}`,
    Object.keys(live).sort().join(',') === 'lastHeartbeat,pid,status', Object.keys(live).join(','))
  check(`${b.name}: liveness status/pid values are sane`, live.status === 'live' && live.pid === process.pid)

  await writeFailureMarker('runtime-smoke synthetic failure', 'unknown')
  const fail1 = JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
  check(`${b.name}: failure marker keys are exactly {status, reason, code, since, pid}`,
    Object.keys(fail1).sort().join(',') === 'code,pid,reason,since,status', Object.keys(fail1).join(','))
  check(`${b.name}: failure base values are sane`,
    fail1.status === 'failed' && fail1.reason === 'runtime-smoke synthetic failure' && fail1.code === 'unknown' && !Number.isNaN(Date.parse(fail1.since)))
}
{
  // The ext rule, exercised through the one backend that extends (slack):
  // extras land under ext:{...}, and the base key set stays fixed.
  const { writeFailureMarker, FAILURE_MARKER_PATH } = mods['channel-slack.mjs']
  await writeFailureMarker('runtime-smoke ext failure', 'slack_token_bad', { token: 'bot' })
  const marker = JSON.parse(fs.readFileSync(FAILURE_MARKER_PATH, 'utf8'))
  check('extended failure marker keys are exactly base + ext',
    Object.keys(marker).sort().join(',') === 'code,ext,pid,reason,since,status', Object.keys(marker).join(','))
  check('the extension rides under ext', marker.ext?.token === 'bot', JSON.stringify(marker.ext))
  check('no extension field leaked to the top level', !('token' in marker))
}

// ── cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
