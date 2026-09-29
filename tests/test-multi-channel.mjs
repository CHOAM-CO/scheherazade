// test-multi-channel.mjs -- 0.3.7 multi-channel: several messengers at once.
//   1. config: list form + legacy migration (channel-backends.cjs, http-server readAgentConfig)
//   2. channel-id ownership (primary -> companion tool forwarding)
//   3. spawn-per-channel: companion manager with fake spawn/timers (own creds only,
//      independent restart ladders, status, stopAll)
//   4. turn serialization: turn-gate state machine + the REAL lane with a fake claude
//   5. source pins for the seams that fail open silently
// Run: node tests/test-multi-channel.mjs

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-multi-'))
process.env.AGENT_DATA_HOME = path.join(TMP, 'home')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
const require_ = createRequire(path.join(ROOT, 'package.json'))
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── 1. config ──────────────────────────────────────────────────────────────
console.log('1. config: list form + migration')
const B = require_(path.join(ROOT, 'channel-backends.cjs'))
check('empty config -> [discord]', JSON.stringify(B.parseBackends({})) === '["discord"]')
check('legacy CHANNEL_BACKEND=slack -> [slack] (old install, one channel)', JSON.stringify(B.parseBackends({ CHANNEL_BACKEND: 'slack' })) === '["slack"]')
check('list wins over legacy, order kept', JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'telegram, Discord', CHANNEL_BACKEND: 'slack' })) === '["telegram","discord"]')
check('dupes + unknowns dropped', JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'slack,matrix,slack' })) === '["slack"]')
check('only-unknown list falls back to legacy then discord', JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'matrix', CHANNEL_BACKEND: 'telegram' })) === '["telegram"]'
  && JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'matrix' })) === '["discord"]')
check('local alone stands; local + messenger drops local', JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'local' })) === '["local"]'
  && JSON.stringify(B.parseBackends({ CHANNEL_BACKENDS: 'local,slack' })) === '["slack"]')
const f = B.backendConfigFields(['slack', 'discord'])
check('write form carries BOTH keys, legacy = primary (rollback-safe)', f.CHANNEL_BACKENDS === 'slack,discord' && f.CHANNEL_BACKEND === 'slack')
check('migrationFields: legacy-only config gets the list; already-migrated is a no-op',
  B.migrationFields({ CHANNEL_BACKEND: 'telegram' }).CHANNEL_BACKENDS === 'telegram' && B.migrationFields(f) === null)

const http = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
const cfgPath = path.join(process.env.AGENT_DATA_HOME, '.agent-config')
fs.writeFileSync(cfgPath, 'MODEL=x\nCHANNEL_BACKEND=telegram\n')
check('http-server: legacy config reads as list AND active backend unchanged',
  http.enabledChannelBackends().join() === 'telegram' && http.activeChannelBackend() === 'telegram')
check('migrate-on-read persists the list form once', http.migrateChannelBackendsOnDisk() === true
  && /^CHANNEL_BACKENDS=.*telegram/m.test(fs.readFileSync(cfgPath, 'utf8')) && /^CHANNEL_BACKEND=.*telegram/m.test(fs.readFileSync(cfgPath, 'utf8'))
  && /MODEL=/.test(fs.readFileSync(cfgPath, 'utf8')))
check('second migrate is a no-op', http.migrateChannelBackendsOnDisk() === false)
fs.writeFileSync(cfgPath, 'MODEL=x\n')
check('fresh install (no backend key) is NOT touched by migration', http.migrateChannelBackendsOnDisk() === false && !/CHANNEL_BACKEND/.test(fs.readFileSync(cfgPath, 'utf8')))
fs.writeFileSync(cfgPath, 'CHANNEL_BACKENDS=slack,discord\nCHANNEL_BACKEND=slack\n')
check('multi list: primary = first, enabled = both', http.activeChannelBackend() === 'slack' && http.enabledChannelBackends().join() === 'slack,discord')

// ── 2. channel-id ownership ────────────────────────────────────────────────
console.log('\n2. channel-id ownership')
check('slack ids', B.backendForChannelId('C09ABCDEF12') === 'slack' && B.backendForChannelId('D0123456789') === 'slack')
check('discord snowflake', B.backendForChannelId('1490192400495153262') === 'discord')
check('telegram chat ids (positive, supergroup negative)', B.backendForChannelId('123456789') === 'telegram' && B.backendForChannelId('-1001234567890') === 'telegram')
check('in-app / empty / junk', B.backendForChannelId('in-app') === 'local' && B.backendForChannelId('') === null && B.backendForChannelId('hello') === null)

// ── 3. spawn per channel (fakes) ───────────────────────────────────────────
console.log('\n3. companion manager: one process per channel, independent restarts')
const { createCompanionManager } = await import(pathToFileURL(path.join(ROOT, 'channel-companions.mjs')).href)
const { backoffFor } = await import(pathToFileURL(path.join(ROOT, 'supervisor.mjs')).href)
{
  const spawned = []
  let clock = 1_000_000
  const timers = []
  const fakeSpawn = (spec) => {
    const c = new EventEmitter()
    c.pid = 1000 + spawned.length
    c.stdin = { end() { c.stdinEnded = true } }
    spawned.push({ spec, child: c })
    return c
  }
  const mgr = createCompanionManager({
    spawn: fakeSpawn, dataHome: path.join(TMP, 'home'), backoffFor,
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimer: (t) => { t.cleared = true },
    now: () => clock,
  })
  mgr.start([
    { backend: 'slack', cmd: 'node', args: ['channel-slack.mjs'], env: { SLACK_BOT_TOKEN: 'xoxb-S', SLACK_APP_TOKEN: 'xapp-S', SCHEHERAZADE_CHANNEL_ROLE: 'companion' } },
    { backend: 'telegram', cmd: 'node', args: ['channel-telegram.mjs'], env: { TELEGRAM_BOT_TOKEN: 'tg-T', SCHEHERAZADE_CHANNEL_ROLE: 'companion' } },
  ])
  check('two companions -> two child processes', spawned.length === 2)
  const slackEnv = spawned[0].spec.env; const tgEnv = spawned[1].spec.env
  check('each child carries only its own credentials',
    slackEnv.SLACK_BOT_TOKEN && !slackEnv.TELEGRAM_BOT_TOKEN && tgEnv.TELEGRAM_BOT_TOKEN && !tgEnv.SLACK_BOT_TOKEN && !tgEnv.SLACK_APP_TOKEN && !tgEnv.DISCORD_BOT_TOKEN)
  check('status: both running, no restarts', mgr.status().slack.state === 'running' && mgr.status().telegram.state === 'running' && mgr.status().slack.restarts === 0)

  clock += 5_000
  spawned[0].child.emit('exit', 1, null) // slack crashes fast
  let st = mgr.status()
  check('slack crash -> backoff (5s), telegram untouched', st.slack.state === 'backoff' && st.slack.restarts === 1 && timers.at(-1).ms === 5000 && st.telegram.state === 'running' && st.telegram.pid === spawned[1].child.pid)
  timers.at(-1).fn()
  check('slack respawned by its own timer; telegram not respawned', spawned.length === 3 && spawned[2].spec.backend === 'slack')
  clock += 1_000
  spawned[2].child.emit('exit', 1, null)
  check('second fast crash climbs the ladder (10s)', timers.at(-1).ms === 10000 && mgr.status().slack.restarts === 2)
  timers.at(-1).fn()
  clock += 120_000 // healthy run
  spawned[3].child.emit('exit', 0, null)
  check('a healthy run resets the ladder', mgr.status().slack.restarts === 1 && timers.at(-1).ms === 5000)
  // a failure marker written by the companion surfaces in status (not in the agent's own marker)
  fs.writeFileSync(path.join(TMP, 'home', '.agent-failed.slack.json'), JSON.stringify({ status: 'failed', code: 'slack_token_bad', reason: 'invalid_auth' }))
  check('companion failure marker surfaces per channel', mgr.status().slack.failure && mgr.status().slack.failure.code === 'slack_token_bad')
  check('companion failure never touches the agent-wide marker file', !fs.existsSync(path.join(TMP, 'home', '.agent-failed.json')))

  const killed = []
  mgr.stopAll((c) => killed.push(c.pid))
  check('stopAll ends live companions (stdin lifeline closed + kill) and cancels timers',
    killed.includes(spawned[1].child.pid) && spawned[1].child.stdinEnded === true && timers.at(-1).cleared === true)
  spawned[1].child.emit('exit', 0, null)
  check('no respawn after stopAll', spawned.length === 4)
  check('status empty after stopAll', Object.keys(mgr.status()).length === 0)
}

// ── 4. turn serialization ──────────────────────────────────────────────────
console.log('\n4. turn gate')
const { createTurnGate } = await import(pathToFileURL(path.join(ROOT, 'turn-gate.mjs')).href)
{
  const off = createTurnGate({ enabled: false })
  check('disabled gate always delivers (single-channel installs unchanged)', off.admit('slack', true) === 'deliver' && off.admit('discord', true) === 'deliver')
  const g = createTurnGate({ enabled: true })
  check('idle lane: opens a turn and owns it', g.admit('discord', false) === 'deliver' && g.owner === 'discord')
  check('same surface mid-turn merges (steering unchanged)', g.admit('discord', true) === 'deliver')
  check('other surface mid-turn queues', g.admit('slack', true) === 'queue')
  g.enqueue({ surface: 'slack', content: 's1', ts: 1 }); g.enqueue({ surface: 'telegram', content: 't1', ts: 2 }); g.enqueue({ surface: 'slack', content: 's2', ts: 3 })
  const r = g.release()
  check('turn end releases the oldest surface with all its queued messages, in order', r.map((x) => x.content).join() === 's1,s2' && g.owner === 'slack' && g.size === 1)
  check('next turn end releases the next surface', g.release().map((x) => x.content).join() === 't1' && g.owner === 'telegram')
  check('empty queue -> idle, owner cleared', g.release().length === 0 && g.owner === null)
  check('surfaceless inbound (system/legacy) never queues', g.admit('', true) === 'deliver')
}

const WIN = process.platform === 'win32'
if (WIN) console.log('  SKIP lane E2E on win32 (sh shim)')
else {
  async function runLane(multi) {
    const MEM = path.join(TMP, `mem-${multi ? 'multi' : 'single'}`)
    fs.mkdirSync(MEM, { recursive: true })
    const allow = path.join(TMP, `allow-${multi}`)
    const sink = path.join(TMP, `sink-${multi}.jsonl`)
    const fakeClaude = path.join(TMP, `fake-claude-${multi}.mjs`)
    // Writes every stdin line to the sink; emits a success `result` only when the ALLOW file exists.
    fs.writeFileSync(fakeClaude, `
import fs from 'node:fs'
import { createInterface } from 'node:readline'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
out({ type: 'system', subtype: 'init', session_id: 'sess-multi', model: 'fake', mcp_servers: [] })
let owed = false
createInterface({ input: process.stdin }).on('line', (l) => { fs.appendFileSync(process.env.FAKE_SINK, l + '\\n'); owed = true })
setInterval(() => { if (owed && fs.existsSync(process.env.FAKE_ALLOW)) { fs.unlinkSync(process.env.FAKE_ALLOW); owed = false; out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, result: 'ok' }) } }, 40)
process.on('SIGTERM', () => process.exit(0))
`)
    const shim = path.join(TMP, `shim-${multi}.sh`)
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeClaude)} "$@"\n`, { mode: 0o755 })
    const lane = spawn(process.execPath, [path.join(ROOT, 'headless-lane.mjs')], {
      env: { ...process.env, MEM, MODEL: 'fake', CLAUDE_BIN: shim, FAKE_SINK: sink, FAKE_ALLOW: allow, SCHEHERAZADE_MULTI_CHANNEL: multi ? '1' : '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const ep = path.join(MEM, '.ingest-endpoint.json')
    for (let i = 0; i < 160 && !fs.existsSync(ep); i++) await new Promise((r) => setTimeout(r, 50))
    const { port, token } = JSON.parse(fs.readFileSync(ep, 'utf8'))
    const post = async (surface, content) => {
      const res = await fetch(`http://127.0.0.1:${port}/inbound`, {
        method: 'POST', headers: { 'x-ingest-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ content, surface, meta: { sender: 'u', channelId: 'system' } }),
      })
      return res.json()
    }
    const lines = () => (fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).message.content[0].text) : [])
    const waitFor = async (pred) => { for (let i = 0; i < 100; i++) { if (pred()) return true; await new Promise((r) => setTimeout(r, 50)) } return false }
    return { lane, MEM, allow, post, lines, waitFor }
  }

  console.log('  -- gate ON (two messengers enabled)')
  const L = await runLane(true)
  await L.post('discord', 'D1')
  await L.waitFor(() => L.lines().length === 1)
  const qres = await L.post('slack', 'S1')
  check('second messenger mid-turn is acked as queued', qres.ok === true && qres.queued === true)
  await new Promise((r) => setTimeout(r, 300))
  check('queued message did NOT reach the agent while the discord turn runs', L.lines().length === 1 && L.lines()[0].includes('D1'))
  const pend = JSON.parse(fs.readFileSync(path.join(L.MEM, '.headless-pending.json'), 'utf8'))
  check('queued message is durable in the pending FIFO (queued:true)', pend.some((e) => e.queued === true && e.content === 'S1'))
  await L.post('discord', 'D2')
  await L.waitFor(() => L.lines().length === 2)
  check('same-surface follow-up still merges into the running turn', L.lines()[1].includes('D2'))
  fs.writeFileSync(L.allow, '1') // discord turn ends
  await L.waitFor(() => L.lines().length === 3)
  check('turn end delivers the queued slack message next', L.lines()[2] && L.lines()[2].includes('S1'))
  const pend2 = JSON.parse(fs.readFileSync(path.join(L.MEM, '.headless-pending.json'), 'utf8'))
  check('delivered item is a normal FIFO entry now (no queued flag)', !pend2.some((e) => e.queued))
  await L.post('discord', 'D3')
  await new Promise((r) => setTimeout(r, 200))
  check('while the slack turn runs, a discord message waits (turns never overlap)', L.lines().length === 3)
  fs.writeFileSync(L.allow, '1')
  await L.waitFor(() => L.lines().length === 4)
  check('and is delivered when the slack turn ends', L.lines()[3] && L.lines()[3].includes('D3'))
  L.lane.kill('SIGTERM'); await new Promise((r) => L.lane.on('exit', r))

  console.log('  -- gate OFF (single messenger: behaviour byte-identical to 0.3.6)')
  const S = await runLane(false)
  await S.post('discord', 'D1')
  await S.waitFor(() => S.lines().length === 1)
  const r2 = await S.post('slack', 'S1')
  await S.waitFor(() => S.lines().length === 2)
  check('no gate: other surface is delivered immediately, never queued', r2.queued === undefined && S.lines().length === 2)
  S.lane.kill('SIGTERM'); await new Promise((r) => S.lane.on('exit', r))
}

// ── 5. source pins ─────────────────────────────────────────────────────────
console.log('\n5. source pins')
const main = read('main.cjs'); const lane = read('headless-lane.mjs'); const rt = read('channel-runtime.mjs')
check('main.cjs: credentials resolved per backend through one function, primary + companions', /function resolveChannelCredentials\(backend, config\)/.test(main)
  && /resolveChannelCredentials\(channelBackend, config\)/.test(main) && /resolveChannelCredentials\(backend, config\)/.test(main))
check('main.cjs: companions get role + surface env and a scrubbed channel-secret env', /SCHEHERAZADE_CHANNEL_ROLE: 'companion'/.test(main) && /delete env\[k\]/.test(main))
check('main.cjs: multi flag only when >1 messenger; companions stop on supervisor exit and quit',
  /enabledBackends\.length > 1 \? \{ SCHEHERAZADE_MULTI_CHANNEL: '1' \}/.test(main) && (main.match(/stopChannelCompanions\(\)/g) || []).length >= 4)
check('main.cjs: reads the list form (no raw CHANNEL_BACKEND read left)', !/config\.CHANNEL_BACKEND\b/.test(main) && !/readAgentConfig\(\)\.CHANNEL_BACKEND\b/.test(main))
check('agentControls exposes channelStatus; /api/channels/status returns it', /channelStatus,/.test(main) && /agentControls\.channelStatus/.test(read('onboarding/routes/channels.cjs')))
check('routes: /api/channels/enabled exists, guards last channel + unconfigured; switch/local stamp write the list form',
  /\/api\/channels\/enabled/.test(read('onboarding/routes/channels.cjs')) && /last_channel/.test(read('onboarding/routes/channels.cjs'))
  && (read('onboarding/routes/channels.cjs').match(/backendConfigFields\(/g) || []).length >= 3)
check('every channel script: companion role skips MCP stdio, suffixes markers, forwards foreign channelIds',
  ['channel.mjs', 'channel-slack.mjs', 'channel-telegram.mjs'].every((f) => {
    const s = read(f)
    return /createMarkerStore\(\{ dataHome: DATA_HOME, suffix: IS_COMPANION/.test(s) && /startCompanionToolServer/.test(s) && /companionForward\(name, args\)/.test(s) && /if \(IS_COMPANION\) \{[\s\S]{0,200}startCompanionToolServer/.test(s)
  }))
check('companions never run system-turn injectors (routines/schedules/shutdown/autonomy/cadence)',
  ['channel.mjs', 'channel-slack.mjs', 'channel-telegram.mjs'].every((f) => { const s = read(f); return !/^\s+startRoutineTicker\(\{/m.test(s) && /if \(!IS_COMPANION\) startRoutineTicker\(/.test(s) && /if \(!IS_COMPANION\) startScheduleTicker\(/.test(s) })
  && /if \(!IS_COMPANION\) \{ startShutdownRequestWatcher\(\); startAutonomyWatcher\(\) \}/.test(read('channel.mjs')))
check('notifier posts the surface to the lane; lane gates on it', /surface \? \{ \.\.\.params, surface \}/.test(rt) && /payload\.surface/.test(lane) && /turnGate\.admit\(surface, openTurn\)/.test(lane))
check('lane: result pays but keeps queued entries; STOP keeps them; boot redelivery strips the flag',
  /ev\.queued \|\| \(Number\(ev\.ts\) \|\| 0\) > resultTs/.test(lane) && /filter\(\(ev\) => ev\.queued\)/.test(lane) && /\(\{ queued, \.\.\.ev \}\)/.test(lane))
check('package.json ships the new runtime files (both file lists)', ['channel-backends.cjs', 'channel-companions.mjs', 'turn-gate.mjs'].every((n) => (read('package.json').match(new RegExp(`"${n.replace('.', '\\.')}"`, 'g')) || []).length === 2))
check('UI: channels page has on/off switch + per-channel state; nav reads the list', /\/api\/channels\/enabled/.test(read('onboarding/public/js/channels.js')) && /role', 'switch'/.test(read('onboarding/public/js/channels.js')) && /CHANNEL_BACKENDS/.test(read('onboarding/public/js/nav.js')))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
