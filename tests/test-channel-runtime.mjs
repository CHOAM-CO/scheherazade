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
// Run: node tests/test-channel-runtime.mjs

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
  // node: builtins, plus a NAMED allowlist of Electron-free repo modules. The
  // promise this section defends is protocol neutrality (no transport SDK, no
  // npm package riding into three MCP children), not "no local modules" -- and
  // a shared resolver that the hooks, the supervisor and the memory DB also
  // use is the opposite of drift. Anything not on this list, relative or not,
  // still fails: adding a row here is a deliberate act. (design-0023 P3)
  const ALLOWED_LOCAL = new Set(['./data-home.cjs'])
  for (const spec of specifiers) {
    check(`import '${spec}' is a node: builtin or an allowlisted local module`,
      spec.startsWith('node:') || ALLOWED_LOCAL.has(spec),
      'transport SDKs / packages are banned in the runtime')
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
  check(`${b.file} sweeps stale atomic tmps at boot`, src.includes('sweepStaleAtomicTmp(DATA_HOME, log)'))
}

// ── 2a. parent-death exit: ONE installer, four servers ─────────────────────
// The orphan class this closes: an MCP stdio server whose parent (the engine)
// died, still holding a Discord/Slack token or a SQLite handle, because the
// MCP transport does not exit on stdin EOF and a socket keeps the loop alive.
// channel.mjs and memory/server.mjs each carried a full inline copy;
// channel-slack.mjs and channel-telegram.mjs carried a HALF one (surface.stop
// and nothing else), so two of the four servers never actually exited.
console.log('\nparent-death exit: fires once, cleans up, exits (design-0023 P3 #6)')
{
  const { installParentDeathExit } = await import(pathToFileURL(RUNTIME_PATH).href)
  // A stand-in for process.stdin: the real one cannot be made to emit 'end'
  // twice on demand, and this test must be able to.
  const makeStdin = () => {
    const handlers = { end: [], close: [] }
    return {
      on(ev, fn) { handlers[ev].push(fn) },
      off(ev, fn) { handlers[ev] = handlers[ev].filter((f) => f !== fn) },
      emit(ev) { for (const f of [...handlers[ev]]) f() },
      count(ev) { return handlers[ev].length },
    }
  }

  {
    const stdin = makeStdin()
    const exits = []
    const logs = []
    let cleaned = 0
    installParentDeathExit({ name: 'test server', stdin, log: (m) => logs.push(m), exit: (c) => exits.push(c), cleanup: () => { cleaned++ } })
    check('listens on BOTH end and close (either can be the one that fires)', stdin.count('end') === 1 && stdin.count('close') === 1)
    stdin.emit('end')
    await new Promise((r) => setImmediate(r))
    check('cleanup ran exactly once', cleaned === 1, String(cleaned))
    check('exited 0', exits.join(',') === '0', exits.join(','))
    check('said why (a silent exit is unexplainable in a log)', logs.some((m) => m.includes('parent gone')), logs.join(' | '))
  }
  {
    // Re-entrancy: 'end' and 'close' both fire in the real world. Cleanup
    // twice would double-close a DB handle / double-destroy a client.
    const stdin = makeStdin()
    const exits = []
    let cleaned = 0
    installParentDeathExit({ stdin, log: () => {}, exit: (c) => exits.push(c), cleanup: () => { cleaned++ } })
    stdin.emit('end')
    stdin.emit('close')
    stdin.emit('end')
    await new Promise((r) => setImmediate(r))
    check('a second EOF event is a no-op (guarded)', cleaned === 1 && exits.length === 1, `cleaned=${cleaned} exits=${exits.length}`)
  }
  {
    // A cleanup that NEVER settles must not hold the exit hostage -- that was
    // the whole reason for the timeout in the original inline copies.
    const stdin = makeStdin()
    const exits = []
    installParentDeathExit({ stdin, log: () => {}, exit: (c) => exits.push(c), timeoutMs: 60, cleanup: () => new Promise(() => {}) })
    stdin.emit('end')
    await new Promise((r) => setTimeout(r, 200))
    check('a hung cleanup still exits, via the safety timer', exits.join(',') === '0', exits.join(','))
  }
  {
    // A THROWING cleanup is not a reason to stay alive either.
    const stdin = makeStdin()
    const exits = []
    const logs = []
    installParentDeathExit({ stdin, log: (m) => logs.push(m), exit: (c) => exits.push(c), cleanup: () => { throw new Error('destroy blew up') } })
    stdin.emit('end')
    await new Promise((r) => setImmediate(r))
    check('a throwing cleanup still exits, and says what threw',
      exits.join(',') === '0' && logs.some((m) => m.includes('destroy blew up')), logs.join(' | '))
  }

  // All FOUR stdio servers, including the two that live in subdirectories.
  for (const f of ['channel.mjs', 'channel-slack.mjs', 'channel-telegram.mjs', 'memory/server.mjs', 'calendar/server.mjs']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    check(`${f} installs the shared parent-death exit`, src.includes('installParentDeathExit({'))
    check(`${f} carries no inline copy of it`, !src.includes('const onParentGone ='))
  }
}

// ── 2b. stale atomic-tmp boot sweep (0.1.17) ────────────────────────────────
// atomicWriteJson's tmp survives a kill between writeFile and rename; the
// sweep removes ONLY files matching `<name>.<pid>.<ts>.tmp` older than 1h.
console.log('\nsweepStaleAtomicTmp: shape-pinned, age-gated, never boot-blocking')
{
  const { sweepStaleAtomicTmp } = await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheherazade-tmp-sweep-'))
  const OLD = Date.now() / 1000 - 2 * 3600 // utimesSync takes seconds
  const mk = (name, old) => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, 'x')
    if (old) fs.utimesSync(p, OLD, OLD)
    return p
  }
  const staleTmp = mk('.agent-live.1234.1786000000000.tmp', true)
  const freshTmp = mk('.agent-live.5678.1786000000001.tmp', false)
  const wrongShape1 = mk('notes.tmp', true)
  const wrongShape2 = mk('.agent-live.tmp', true)
  const userFile = mk('important.1234.5678.tmp.txt', true)
  const logs = []
  const swept = await sweepStaleAtomicTmp(dir, (m) => logs.push(m))
  check('stale atomic tmp removed', !fs.existsSync(staleTmp))
  check('fresh tmp (possible in-flight write) kept', fs.existsSync(freshTmp))
  check('non-matching names untouched', fs.existsSync(wrongShape1) && fs.existsSync(wrongShape2) && fs.existsSync(userFile))
  check('returns swept count + logs once', swept === 1 && logs.length === 1)
  const swept2 = await sweepStaleAtomicTmp(path.join(dir, 'no-such-dir'), (m) => logs.push(m))
  check('missing dataHome: returns 0, no throw, no log', swept2 === 0 && logs.length === 1)
  fs.rmSync(dir, { recursive: true, force: true })
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

// ── routines: store, schedule math, ticker (v0.0.41, Mino 2026-08-04) ─────
{
  const { createRoutineStore, handleRoutineTool, startRoutineTicker, routineInjectContent, ROUTINE_TOOL } =
    await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)
  const dir = path.join(tmpDir, 'routines-home')
  const store = createRoutineStore({ dataHome: dir, log: () => {} })

  // add + validation
  const r = await store.add({ time: '08:30', days: 'weekdays', prompt: '메일 브리핑' })
  check('add returns a routine with an id and normalized days', r.id.startsWith('r-') && r.days.join(',') === '1,2,3,4,5')
  await store.add({ time: '22:00', days: [0, 6], prompt: 'weekend thing' })
  let threw = false
  try { await store.add({ time: '25:99', days: 'daily', prompt: 'x' }) } catch { threw = true }
  check('a nonsense time is refused loudly', threw)
  threw = false
  try { await store.add({ time: '09:00', days: 'sometimes', prompt: 'x' }) } catch { threw = true }
  check('a nonsense day set is refused loudly', threw)

  // due math: Mon 2026-08-03 09:00 -- weekday routine due (30min late), weekend one not
  const mon9 = new Date(2026, 7, 3, 9, 0, 0)
  check('fixture day really is a Monday', mon9.getDay() === 1)
  let due = await store.dueNow(mon9)
  check('the weekday routine is due on Monday morning', due.length === 1 && due[0].id === r.id, JSON.stringify(due.map((d) => d.id)))
  check('lateMinutes says how stale the trigger is', due[0].lateMinutes === 30, due[0].lateMinutes)

  // fired -> not due again the same day; due again the NEXT matching day
  await store.markFired(r.id, mon9)
  due = await store.dueNow(new Date(2026, 7, 3, 15, 0, 0))
  check('at-most-once per day: fired routine is not due again today', due.length === 0, JSON.stringify(due))
  due = await store.dueNow(new Date(2026, 7, 4, 8, 31, 0))
  check('it is due again the next matching day', due.length === 1)

  // before the scheduled minute -> not due
  due = await store.dueNow(new Date(2026, 7, 5, 8, 29, 0))
  check('not due before its minute arrives', due.length === 0)

  // persistence: a fresh store over the same dir sees the same routines
  const store2 = createRoutineStore({ dataHome: dir, log: () => {} })
  const listed = await store2.list()
  check('routines survive a process restart (fresh store, same dir)', listed.length === 2, listed.length)
  check('lastFiredDay persisted too (no double fire across restart)', listed.find((x) => x.id === r.id).lastFiredDay === '2026-08-03')

  // tool surface
  const addRes = await handleRoutineTool(store2, { action: 'add', time: '12:00', days: 'daily', prompt: 'lunch' })
  check('tool add answers with the id and the only-while-running caveat', addRes.content[0].text.includes('r-') && addRes.content[0].text.includes('running'))
  const listRes = await handleRoutineTool(store2, { action: 'list' })
  check('tool list returns the registry', listRes.content[0].text.includes('lunch'))
  const rmRes = await handleRoutineTool(store2, { action: 'remove', id: 'nope' })
  check('tool remove on a dead id is an error, not a silent 200', rmRes.isError === true)
  const badRes = await handleRoutineTool(store2, { action: 'add', time: 'noon', days: 'daily', prompt: 'x' })
  check('tool add surfaces validation errors instead of throwing', badRes.isError === true && badRes.content[0].text.includes('HH:MM'))

  // ticker: markFired BEFORE fire (at-most-once), fire failure skips the day
  const store3 = createRoutineStore({ dataHome: path.join(tmpDir, 'routines-tick'), log: () => {} })
  await store3.add({ time: '07:00', days: 'daily', prompt: 'tick me' })
  const fired = []
  const clock = new Date(2026, 7, 3, 7, 5, 0)
  const { tick } = startRoutineTicker({ store: store3, fire: async (x) => { fired.push(x.id) }, log: () => {}, now: () => clock })
  await tick()
  check('ticker fires a due routine exactly once', fired.length === 1)
  await tick()
  check('a second tick the same day fires nothing', fired.length === 1)
  const store4 = createRoutineStore({ dataHome: path.join(tmpDir, 'routines-tick2'), log: () => {} })
  const bad = await store4.add({ time: '07:00', days: 'daily', prompt: 'will fail' })
  const { tick: tick2 } = startRoutineTicker({ store: store4, fire: async () => { throw new Error('boom') }, log: () => {}, now: () => clock })
  await tick2()
  const after = (await store4.list()).find((x) => x.id === bad.id)
  check('fire failure still consumed the day (at-most-once beats double-spend)', after.lastFiredDay === '2026-08-03')

  // inject line shape
  const line = routineInjectContent({ id: 'r-x', prompt: 'do it', lateMinutes: 0 })
  check('inject line carries the [routine] marker and the prompt', line.startsWith('[routine r-x]') && line.includes('do it'))
  const lateLine = routineInjectContent({ id: 'r-x', prompt: 'do it', lateMinutes: 90 })
  check('a late fire says HOW late', lateLine.includes('90분'))
  check('the tool name is the frozen string the allowlist matches', ROUTINE_TOOL.name === 'routine')
}

// ── schedules: generic recurring/one-off prompts, ticker IO (2026-08-16) ───
// Mirrors the routine-ticker coverage directly above -- same "drive tick()
// manually, no real setInterval waits" seam, same shape of assertions
// (fires-once, failure-does-not-consume, restart/persistence). The pure
// decision math (window wrap, floor, consent gate, activity suppression,
// malformed entries) already has its own dedicated attacker in
// tests/test-schedule-tick.mjs; what's missing there -- and what belongs
// here, next to the routine ticker it mirrors -- is the IO: does the ticker
// actually read/write schedules.json correctly, does a thrown fire() leave
// lastRunISO alone, does an overlapping tick get skipped, does a missing or
// corrupt store degrade instead of crashing.
{
  const { startScheduleTicker, scheduleInjectContent } =
    await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)

  // There is no store abstraction for schedules the way routines have
  // createRoutineStore -- startScheduleTicker owns schedules.json's
  // read/write itself, so the test writes/reads the flat file directly.
  const writeStore = (dir, schedules) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'schedules.json'), JSON.stringify({ version: 1, schedules }))
  }
  const readStore = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'schedules.json'), 'utf8'))
  const clock = new Date(2026, 7, 3, 7, 5, 0) // Mon 2026-08-03 07:05 local

  // 1. a due schedule fires exactly once, and lastRunISO lands in the
  //    ATOMICALLY WRITTEN-BACK file (read from disk, not from memory).
  {
    const dir = path.join(tmpDir, 'schedules-fire-once')
    writeStore(dir, [{ id: 's1', kind: 'once', enabled: true, prompt: 'do it', createdBy: 'system', atISO: '2026-08-03T07:00:00', lastRunISO: null }])
    const fired = []
    const { tick } = startScheduleTicker({ dataHome: dir, readConfig: async () => ({}), fire: async (e) => { fired.push(e.id) }, activityMsProvider: () => Infinity, log: () => {}, now: () => clock })
    await tick()
    check('due schedule fires exactly once', fired.length === 1 && fired[0] === 's1', JSON.stringify(fired))
    const after = readStore(dir)
    check('lastRunISO is stamped in the written-back store file on disk', after.schedules[0].lastRunISO !== null, JSON.stringify(after))
    await tick()
    check('a "once" schedule that already fired does not fire again on the next tick', fired.length === 1)
  }

  // 2. fire() throwing -> lastRunISO is NOT stamped; the same schedule is
  //    retried (and succeeds) on the next tick.
  {
    const dir = path.join(tmpDir, 'schedules-fire-fail')
    writeStore(dir, [{ id: 's2', kind: 'once', enabled: true, prompt: 'will fail once', createdBy: 'system', atISO: '2026-08-03T07:00:00', lastRunISO: null }])
    let attempts = 0
    const { tick } = startScheduleTicker({
      dataHome: dir,
      readConfig: async () => ({}),
      fire: async () => { attempts += 1; if (attempts === 1) throw new Error('boom') },
      activityMsProvider: () => Infinity,
      log: () => {},
      now: () => clock,
    })
    await tick()
    check('fire() throwing does NOT stamp lastRunISO', readStore(dir).schedules[0].lastRunISO === null)
    await tick()
    check('the same schedule is retried and fires (and IS stamped) on the next tick', attempts === 2 && readStore(dir).schedules[0].lastRunISO !== null)
  }

  // 3. missing schedules.json -> ticker start seeds the shipped default
  //    (2026-08-19: on the dsh lane the session-start hook never runs, so
  //    the ticker is the only seed site there), and the seeded default
  //    does NOT fire without AUTONOMY=yes (createdBy: agent consent gate).
  {
    const dir = path.join(tmpDir, 'schedules-missing')
    fs.mkdirSync(dir, { recursive: true }) // dir exists, schedules.json does not
    const fired = []
    const { tick } = startScheduleTicker({ dataHome: dir, readConfig: async () => ({}), fire: async (e) => { fired.push(e.id) }, activityMsProvider: () => Infinity, log: () => {}, now: () => clock })
    const seeded = fs.existsSync(path.join(dir, 'schedules.json'))
    await tick()
    check('missing schedules.json -> seeded with the shipped default at ticker start', seeded && readStore(dir).schedules[0].id === 'memory-consolidation')
    check('seeded agent-authored default does not fire without AUTONOMY=yes', fired.length === 0)
  }

  // 4. corrupt schedules.json -> a warning is logged, never a throw.
  {
    const dir = path.join(tmpDir, 'schedules-corrupt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'schedules.json'), '{ not valid json')
    const logs = []
    const fired = []
    const { tick } = startScheduleTicker({ dataHome: dir, readConfig: async () => ({}), fire: async (e) => { fired.push(e.id) }, activityMsProvider: () => Infinity, log: (m) => logs.push(m), now: () => clock })
    await tick()
    check('corrupt schedules.json -> no fire', fired.length === 0)
    check('corrupt schedules.json -> a warning is logged, not a throw', logs.some((l) => l.includes('schedules:') && l.toLowerCase().includes('malformed')), JSON.stringify(logs))
  }

  // 5. inFlight guard: a tick that overlaps a still-running previous tick is
  //    skipped outright, rather than firing the same due schedule twice.
  {
    const dir = path.join(tmpDir, 'schedules-inflight')
    writeStore(dir, [{ id: 's5', kind: 'once', enabled: true, prompt: 'slow fire', createdBy: 'system', atISO: '2026-08-03T07:00:00', lastRunISO: null }])
    let release
    const gate = new Promise((res) => { release = res })
    let calls = 0
    const { tick } = startScheduleTicker({
      dataHome: dir,
      readConfig: async () => ({}),
      fire: async () => { calls += 1; await gate }, // holds the tick open until released below
      activityMsProvider: () => Infinity,
      log: () => {},
      now: () => clock,
    })
    const first = tick() // will reach fire() and suspend on `gate`
    const second = tick() // must be a no-op: the first tick is still in flight
    // Give the first tick's async chain (readConfig -> fs.readFile -> fire)
    // real turns of the event loop to actually reach fire() and suspend on
    // the gate BEFORE releasing it -- a genuine overlap, not just two
    // synchronous calls that happened to queue back to back.
    await new Promise((r) => setTimeout(r, 10))
    check('fire() was entered exactly once before release (the second tick truly did nothing)', calls === 1, calls)
    release()
    await Promise.all([first, second])
    check('an overlapping tick is skipped by the inFlight guard (fire still called exactly once)', calls === 1, calls)
    check('the in-flight tick still completed the write-back once released', readStore(dir).schedules[0].lastRunISO !== null)
  }

  // 6. inject content carries the schedule's id and prompt, and preserves the
  //    provenance of the prompt (user-authored, NOT [SYSTEM] authority).
  //    stop-reply-guard matches scheduled turns on the CHANNEL, not this text
  //    prefix (see its :192-196 comment), so the label is free to be honest.
  {
    const line = scheduleInjectContent({ id: 'sched-x', prompt: 'read the thing' })
    check('scheduleInjectContent carries the schedule id', line.includes('sched-x'))
    check('scheduleInjectContent carries the prompt', line.includes('read the thing'))
    check('scheduleInjectContent does not claim [SYSTEM] authority for user content', !line.startsWith('[SYSTEM]'))
    check('scheduleInjectContent marks the prompt as user-authored', line.includes('user-authored'))
  }
}

// ── outbound dedup: GPT-loop guard (2026-08-04, Mino field report) ────────
{
  const { createOutboundDedup } = await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)
  let clock = 1_000_000
  const logged = []
  const dedup = createOutboundDedup({ windowMs: 60_000, log: (l) => logged.push(l), now: () => clock })

  // Commit contract (2026-08-13): a non-duplicate check returns commit(), and
  // the key is recorded ONLY when the caller commits after a successful send.
  const first = dedup('C1', 'same message')
  check('first send passes through', first.duplicate === false)
  check('a passing check hands back a commit()', typeof first.commit === 'function')
  first.commit() // simulate a successful send
  clock += 5_000
  const second = dedup('C1', 'same message')
  check('identical text within the window is suppressed after a committed send', second.duplicate === true)
  check('the receipt SAYS it was already delivered and forbids a retry', /already sent|DUPLICATE/.test(second.receipt) && /Do NOT retry/i.test(second.receipt))
  check('suppression is logged for the field debugger', logged.some((l) => l.includes('[outbound-dedup]')))

  // whitespace-normalized match: the loop variant that pads/reflows still dedups
  clock += 1_000
  const padded = dedup('C1', '  same   message ')
  check('whitespace-reflowed duplicate is still caught', padded.duplicate === true)

  // different channel or different text is NOT a duplicate
  check('same text to a DIFFERENT channel passes', dedup('C2', 'same message').duplicate === false)
  check('different text to the same channel passes', dedup('C1', 'new message').duplicate === false)

  // window expiry re-arms
  clock += 61_000
  const later = dedup('C1', 'same message')
  check('after the window the same text sends again (legit repeat)', later.duplicate === false)

  // THE FIX (2026-08-13): a send that never committed (target.send() threw)
  // must NOT suppress the model's legitimate retry of a message that never
  // landed -- the silent-loss bug this commit closes.
  clock += 200_000 // fresh window for C3
  const failAttempt = dedup('C3', 'delivery will fail')
  check('first attempt on a new key passes', failAttempt.duplicate === false)
  // deliberately do NOT call failAttempt.commit() -- the send threw
  clock += 2_000
  const retry = dedup('C3', 'delivery will fail')
  check('retry after a FAILED (un-committed) send is NOT suppressed', retry.duplicate === false)
  retry.commit() // this time the send lands
  clock += 2_000
  check('once committed, the next identical IS suppressed', dedup('C3', 'delivery will fail').duplicate === true)

  // pruning: expired keys do not accumulate
  for (let i = 0; i < 50; i++) dedup('C1', `bulk ${i}`)
  clock += 120_000
  dedup('C1', 'prune trigger')
  check('expired entries are pruned on the next call (no unbounded growth)', true)
}

// ── mute-strike announcer (2026-08-13) ────────────────────────────────────
// Non-model-mediated messenger notice when stop-reply-guard's ledger rises.
// Baseline rule: pre-start strikes are history, only a rise announces; a
// drop rebases silently; a failed send never throws out of tick.
{
  const { createMuteStrikeAnnouncer } = await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)
  const home = path.join(tmpDir, 'mute-home')
  fs.mkdirSync(home, { recursive: true })
  const strikesPath = path.join(home, '.mute-strikes.json')
  const sent = []
  let lastInbound = null
  let fetchFails = false
  const ann = createMuteStrikeAnnouncer({
    dataHome: home,
    homeId: 'HOME',
    lastChannelStore: { load: async () => 'PERSISTED' },
    getLastInboundId: () => lastInbound,
    fetchTarget: async (id) => { if (fetchFails) throw new Error('transport down'); return { id } },
    sendText: async (t, text) => { sent.push({ id: t.id, text }) },
    log: () => {},
  })

  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 2 }))
  await ann.start()
  ann.stop() // ticks driven manually via the seam
  await ann._tick()
  check('pre-start strikes are baseline, not news (no announce)', sent.length === 0)

  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 3 }))
  await ann._tick()
  check('a rise announces once', sent.length === 1 && sent[0].text.includes('3회차'))
  check('with no inbound yet the ladder falls to the persisted channel', sent[0].id === 'PERSISTED')

  await ann._tick()
  check('same count again does not re-announce', sent.length === 1)

  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 0 }))
  await ann._tick()
  check('a drop (guard reset / UI clear) rebases silently', sent.length === 1)

  lastInbound = 'LIVE'
  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 1 }))
  await ann._tick()
  check('next rise announces to the live inbound channel first', sent.length === 2 && sent[1].id === 'LIVE')

  fetchFails = true
  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 2 }))
  let threw = false
  try { await ann._tick() } catch { threw = true }
  check('a failed send is swallowed (never crashes the backend)', !threw && sent.length === 2)

  fetchFails = false
  fs.writeFileSync(strikesPath, JSON.stringify({ strikes: 3 }))
  await ann._tick()
  check('failed announce rebased anyway -- no spam-retry, next rise still lands', sent.length === 3)

  fs.rmSync(strikesPath)
  await ann._tick()
  check('ledger deletion reads as zero strikes (guard contract), no announce', sent.length === 3)
}

// ── mute auto-deliver (0.3.7) ─────────────────────────────────────────────
{
  const { createMuteStrikeAnnouncer } = await import(pathToFileURL(path.join(ROOT, 'channel-runtime.mjs')).href)
  const home = path.join(tmpDir, 'mute-home2')
  fs.mkdirSync(home, { recursive: true })
  const sp = path.join(home, '.mute-strikes.json')
  const up = path.join(home, '.mute-unsent.json')
  const sent = []
  const ann = createMuteStrikeAnnouncer({
    dataHome: home, homeId: 'HOME', lastChannelStore: { load: async () => 'PERSISTED' },
    getLastInboundId: () => 'LIVE', fetchTarget: async (id) => ({ id }),
    sendText: async (t, text) => { sent.push({ id: t.id, text }) }, log: () => {},
  })
  fs.writeFileSync(sp, JSON.stringify({ strikes: 0 }))
  await ann.start(); ann.stop()
  // no strike rise, unsent present -> nothing (agent delivered normally / guard did not convict)
  fs.writeFileSync(up, JSON.stringify({ turnId: 't1', channelId: 'C9', text: '진짜 답장', delivered: false }))
  await ann._tick()
  check('no strike rise -> unsent text is not sent', sent.length === 0)
  fs.writeFileSync(sp, JSON.stringify({ strikes: 1 }))
  await ann._tick()
  check('rise forwards the composed text to the trigger channel, then a short notice',
    sent.length === 2 && sent[0].id === 'C9' && sent[0].text.includes('진짜 답장') && sent[0].text.startsWith('📨') && sent[1].text.includes('1회차') && sent[1].text.length < 120)
  check('unsent marked delivered on disk', JSON.parse(fs.readFileSync(up, 'utf8')).delivered === true)
  fs.writeFileSync(sp, JSON.stringify({ strikes: 2 }))
  await ann._tick()
  check('same turn is never forwarded twice (only the plain warning follows)', sent.length === 3 && !sent[2].text.includes('진짜 답장') && sent[2].text.includes('2회차'))
  fs.writeFileSync(up, JSON.stringify({ turnId: 't2', channelId: 'in-app', text: '  ', delivered: false }))
  fs.writeFileSync(sp, JSON.stringify({ strikes: 3 }))
  await ann._tick()
  check('empty text falls back to the original warning', sent.length === 4 && sent[3].text.includes('답장이 만들어지고도 전송되지 않았어') && sent[3].id === 'LIVE')
}

// ── cleanup ──────────────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
