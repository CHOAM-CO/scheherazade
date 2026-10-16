import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { hasForcedCancelPatch } from '../tools/assert-dsh-cancel-patch.mjs'
import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'

const source = fs.readFileSync(new URL('../dsh-lane.mjs', import.meta.url), 'utf8')
const start = source.indexOf('export function createTurnControl')
const end = source.indexOf('// ── engine boot', start)
const context = { setTimeout, clearTimeout, process, execFileAsync: promisify(execFile), require: () => ({ POWERSHELL_EXE: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }) }
vm.createContext(context)
vm.runInContext(source.slice(start, end).replaceAll('export ', '') + '\nthis.create = createTurnControl; this.roots = toolProcessRoots; this.kill = killOwnedTools; this.rows = ownedProcessRows; this.isMcp = isMcpTransport; this.snapshot = turnInfrastructureSnapshot; this.bounded = boundedInfrastructure; this.startMillis = processStartMillis', context)
let clear = 0; let kills = 0; let resolveCancel
const control = context.create({ cancel: () => new Promise(resolve => { resolveCancel = resolve }), clearPending: () => ++clear, killTools: () => { kills++ }, timeoutMs: 50 })
const generation = control.generation
let settled = false
const stopping = control.interrupt().then(r => { settled = true; return r })
await new Promise(resolve => setTimeout(resolve, 5))
assert.equal(settled, false, 'does not acknowledge before cancel settles')
assert.equal(kills, 1, 'force-kills immediately without soft grace')
assert.equal(clear, 1, 'disk FIFO drained')
assert.equal(control.valid(generation), false, 'stale render/promote callback invalidated')
assert.equal(control.blocked, true)
resolveCancel({ accepted: true })
assert.equal((await stopping).stopped, true)
assert.equal(control.valid(generation), false, 'late callbacks still ignored after acknowledgement')
control.resume()
assert.equal(control.valid(control.generation), true)
const failure = context.create({ cancel: () => Promise.reject(new Error('offline')), clearPending: () => true, killTools: () => {}, timeoutMs: 10 })
await assert.rejects(failure.interrupt(), /offline/)
assert.equal(failure.blocked, false, 'failed cancel releases gate')
const timeout = context.create({ cancel: () => new Promise(() => {}), clearPending: () => true, killTools: () => {}, timeoutMs: 5 })
await assert.rejects(timeout.interrupt(), /timed out/)
control.begin(false)
for (let i = 0; i < 100; i++) assert.equal(control.tool(false), 0, 'reply calls excluded')
for (let i = 0; i < 60; i++) assert.equal(control.tool(), 0)
assert.equal(control.warning().budget, 60)
assert.equal(control.warning(), null)
assert.equal(control.tool(), 60)
control.begin(true)
for (let i = 0; i < 12; i++) assert.equal(control.tool(), 0)
assert.equal(control.tool(), 12, 'boot budget is lower')
control.begin(false)
control.claimPrompt('ordinary queued message', 'secret-boot-marker', {})
for (let i = 0; i < 13; i++) assert.equal(control.tool(), 0)
control.claimPrompt('secret-boot-marker greeting', 'secret-boot-marker', {})
for (let i = 0; i < 12; i++) assert.equal(control.tool(), 0)
assert.equal(control.tool(), 12, 'boot budget belongs to claimed prompt, not next turn')
control.begin(false, { DSH_TOOL_BUDGET: '2' })
assert.equal(control.tool(), 0); assert.equal(control.tool(), 0); assert.equal(control.tool(), 2)
assert.deepEqual(Array.from(context.roots([{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }], 10)), [11, 12])

// Exercise the shipped gateway patch without modifying node_modules.
const patchPath = new URL('../patches/@deepseek-ai+dsh-host-apiproxy+0.1.0-rc.7.patch', import.meta.url)
const cwd = new URL('..', import.meta.url)
const forward = spawnSync('git', ['apply', '--check', patchPath.pathname], { cwd, encoding: 'utf8' })
if (forward.status !== 0) execFileSync('git', ['apply', '--check', '--reverse', patchPath.pathname], { cwd, stdio: 'pipe' })
const patch = fs.readFileSync(patchPath, 'utf8')
assert.match(patch, /keepInbox: false/)
assert.match(patch, /target.whenIdle\(\)/)
const gateway = fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js', import.meta.url), 'utf8')
// Reconstruct the patched method from the unified diff additions, without
// writing the installed dependency. Context stays from the actual package.
const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1))
const replacement = added.slice(1).join('\n')
const patched = gateway.includes('for (const target of owned)') ? gateway : gateway
  .replace('cancel(request) {\n\t\t\t\tconst { sessionId }', 'async cancel(request) {\n\t\t\t\tconst { sessionId }')
  .replace('agent.cancel({ kind: "user" }, { keepInbox: true });', replacement.trimStart())
assert.equal(hasForcedCancelPatch(patched), true, 'packaging accepts forced-cancel implementation')
assert.equal(hasForcedCancelPatch(patched.replace('keepInbox: false', 'keepInbox: true')), false, 'packaging refuses undrained inbox')
const method = patched.slice(patched.indexOf('async cancel(request) {'), patched.indexOf('\n\t\t},\n\t\tsubagents:', patched.indexOf('async cancel(request) {'))).trim()
let inbox = ['queued']; let wake = true; let aborted = false; let idle
const agent = { session: {}, cancel (_cause, options) { aborted = true; if (!options.keepInbox) { inbox = []; wake = false } }, whenIdle: () => new Promise(resolve => { idle = resolve }) }
let childCancelled = false
const child = { id: 'child', cancel (_cause, opts) { childCancelled = !opts.keepInbox }, whenIdle: async () => {} }
const registry = { get: () => agent, list: () => [agent, child], isOwnedBy: (id, parent) => id === 'child' && parent === agent }
const sandbox = { ctx: { agents: registry }, hasSubagentOwner: () => false, ok: (_req, value) => value, err: () => { throw new Error('unexpected error') } }
vm.createContext(sandbox)
vm.runInContext('this.handler = ({' + method + '})', sandbox)
const outcome = sandbox.handler.cancel({ payload: { sessionId: 's' } })
assert.equal(aborted, true); assert.deepEqual(inbox, []); assert.equal(wake, false); assert.equal(childCancelled, true)
idle(); assert.equal((await outcome).accepted, true)
// Thinking has no visible-text flag, so the existing mute recovery does not fire.
assert.match(source, /else if \(turnHadUserInbound && sawTextThisTurn\)/)
assert.match(source, /if \(control.blocked\) return/)
assert.match(source, /if \(!control.valid\(generation\)\) return/)
assert.match(source, /const exceeded = control.tool\(!isReplyClassTool\(d.name\)\)/)
assert.match(source, /control.interrupt\(\).then/)
// Real POSIX process ownership: kill a dispatched child, preserve its engine.
if (process.platform !== 'win32') {
  const engine = spawn(process.execPath, ['-e', `
    const {spawn} = require('node:child_process');
    const tool = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    console.log(tool.pid);
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'inherit'] })
  const toolPid = await new Promise(resolve => engine.stdout.once('data', data => resolve(Number(String(data).trim()))))
  try {
    await context.kill(engine.pid)
    process.kill(engine.pid, 0)
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      try { process.kill(toolPid, 0) } catch { alive = false }
    }
    assert.equal(alive, false, 'owned tool exits, engine survives')
  } finally { engine.kill('SIGKILL') }
}
const servers = { channel: { command: 'node', args: ['/app/channel-local.mjs'] } }
assert.equal(context.isMcp({ command: 'node /app/channel-local.mjs' }, servers), true)
assert.equal(context.isMcp({ command: 'node /app/do-work.mjs' }, servers), false)
const killed = []
await context.kill(10, new Set(), {
  readRows: async () => [{ pid: 11, ppid: 10, command: 'node /app/channel-local.mjs' }, { pid: 12, ppid: 11, command: 'sh work' }],
  platform: 'darwin', signal: pid => killed.push(pid), isInfrastructure: row => context.isMcp(row, servers)
})
assert.deepEqual(killed, [], 'late MCP transport and its child survive')

assert.equal(context.isMcp({ command: 'node /app/channel-local.mjs-extra' }, servers), false, 'argv tokens cannot match path substrings')
assert.equal(context.isMcp({ command: 'other-node /app/channel-local.mjs' }, servers), false, 'executable match is exact')
assert.equal(context.isMcp({ command: 'mcp-server' }, { plain: { command: 'mcp-server' } }), true, 'argument-free transport matches')
assert.equal(context.isMcp({ command: 'mcp-server unrelated' }, { plain: { command: 'mcp-server' } }), false)
const wrappedServers = { wrapped: { command: 'npx', args: ['-y', '@pkg/server'] } }
assert.equal(context.isMcp({ command: 'cmd.exe /d /s /c "npx -y @pkg/server"' }, wrappedServers), true)
for (const platform of ['darwin', 'win32']) {
  const signalled = []
  await context.kill(10, new Set([99]), {
    readRows: async () => [
      { pid: 11, ppid: 10, command: 'cmd.exe /d /s /c "npx -y @pkg/server"' },
      { pid: 12, ppid: 11, command: 'node actual-server.js' },
      { pid: 13, ppid: 12, command: 'node browser-helper.js' },
      { pid: 99, ppid: 10, command: 'node unrelated-tool.js' }
    ], platform, signal: pid => signalled.push(pid),
    run: async (_command, args) => signalled.push(Number(args[1])),
    isInfrastructure: row => context.isMcp(row, wrappedServers)
  })
  assert.deepEqual(signalled, [99], `${platform}: wrapper descendants survive, stale snapshot does not protect a tool`)
}

const textStart = source.indexOf('  function eventMessageText (d) {')
const textEnd = source.indexOf('\n  // Turn-close accounting', textStart)
vm.runInContext(source.slice(textStart, textEnd) + '\nthis.messageText = eventMessageText', context)
assert.equal(context.messageText({ content: [{ type: 'text', text: 'claimed greeting marker' }] }), 'claimed greeting marker')

// Budget warnings are status only: never promote, nudge, or create a reply.
const warningStart = source.indexOf('        const warning = control.warning()')
const warningEnd = source.indexOf('        if (exceeded)', warningStart)
for (const channel of ['in-app', 'discord']) {
  const presence = []
  vm.runInNewContext(source.slice(warningStart, warningEnd), {
    control: { warning: () => ({ calls: 48, budget: 60 }) }, lastInboundChannelId: channel,
    postPresence: (...args) => presence.push(args),
    promoteTurnText: () => { throw new Error('warnings must not promote') },
    sendMuteNudge: () => { throw new Error('warnings must not nudge') }
  })
  assert.equal(presence.length, 1)
  assert.equal(presence[0][1], 'activity')
  assert.match(presence[0][0], channel === 'in-app' ? /Tool budget warning/ : /도구 호출/)
}

// Execute the actual lane prompt builder: only voice metadata adds a marker.
const renderStart = source.indexOf('  async function renderInbound (content, meta) {')
const renderEnd = source.indexOf('\n  // Redeliver', renderStart)
const renderContext = {
  bootGreetingMarker: 'boot-token',
  buildPromptContent: async text => ({ text, parts: [] }),
  prependMemoryContext: text => text,
  renderChannelTag: ({ content }) => content
}
vm.createContext(renderContext)
vm.runInContext(source.slice(renderStart, renderEnd) + '\nthis.render = renderInbound', renderContext)
for (const origin of ['voice', 'text', undefined, 'unknown']) {
  const input = 'spoken words'
  const parts = await renderContext.render(input, { origin })
  assert.equal(parts[0].text, origin === 'voice' ? '[voice transcription]\nspoken words' : input)
  assert.equal(input, 'spoken words')
}
const voiceBoot = await renderContext.render('hello', { origin: 'voice', bootGreeting: true })
assert.equal(voiceBoot[0].text, 'boot-token\n[voice transcription]\nhello')

const noted = await renderContext.render('hello', { origin: 'voice', systemNote: 'Call mode off' })
assert.match(noted[0].text, /context only, do not reply to this note/)
assert.match(noted[0].text, /Call mode off/)
assert.ok(noted[0].text.endsWith('[voice transcription]\nhello'))

// Windows-shaped test runs on every host and simulates an already-dead root.
const taskkills = []
await context.kill(10, new Set(), {
  platform: 'win32',
  readRows: async () => [{ pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 12 }, { pid: 14, ppid: 11 }],
  run: async (_command, args) => { taskkills.push(Number(args[1])); throw Object.assign(new Error('already gone'), { code: 128 }) }
})
assert.deepEqual(taskkills, [11], 'only taskkill roots, tolerate dead pids')
let enumCommand
await context.rows({ platform: 'win32', powershell: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', run: async (command, _args, options) => {
  enumCommand = command; assert.equal(options.timeout, 10000); assert.equal(options.maxBuffer, 32 * 1024 * 1024)
  return { stdout: '{"ProcessId":42,"ParentProcessId":10,"CommandLine":"node channel-local.mjs"}' }
} })
assert.match(enumCommand, /System32/)

// Actually capture more than execFile's default 1 MB through the listing seam.
const largeRows = await context.rows({
  platform: 'win32', powershell: 'fixture-powershell',
  run: (_command, _args, options) => promisify(execFile)(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(Array.from({length:7000},(_,i)=>({ProcessId:i+1,ParentProcessId:1,Name:"node",CommandLine:"x".repeat(300)}))))'
  ], options)
})
assert.equal(largeRows.length, 7000, 'large Windows listing exceeds 1 MB without overflow')

// Real HTTP requests drive the actual lane ingest handler, not a fake route.
// Each failure mode must allow the next inbound through, including Windows kill errors.
for (const mode of ['cancel', 'sync-cancel', 'timeout', 'fifo', 'sync-fifo', 'kill']) {
  const lane = { ...context, createServer, Buffer, JSON, Promise, Date,
    childExited: false, openTurn: true, tokenOk: () => true,
    turnText: '', turnHadUserInbound: false, sawTextThisTurn: false, sawReplyThisTurn: false,
    streamTimer: null, streamBuf: '', postPresence: () => {}, errLog: () => {}, log: () => {},
    readPending: () => [], writePending: () => true, opensMuteGate: () => true,
    lastInboundChannelId: 'in-app', renderInbound: async () => [], readAgentConfig: async () => ({}),
    MEM: '', sessionId: 'test', client: { prompt: async () => {} }, bootBoundary: () => {},
    turnConfig: {}, nextBootTurn: false
  }
  lane.control = context.create({
    cancel: () => {
      if (mode === 'sync-cancel') throw new Error('sync cancel failed')
      return mode === 'cancel' ? Promise.reject(new Error('cancel failed')) : mode === 'timeout' ? new Promise(() => {}) : Promise.resolve()
    },
    clearPending: () => { if (mode === 'sync-fifo') throw new Error('clear failed'); return mode !== 'fifo' },
    killTools: async () => { if (mode === 'kill') throw new Error('kill failed') }, timeoutMs: 5
  })
  vm.createContext(lane)
  const routeStart = source.indexOf('  const server = createServer((req, res) => {')
  const routeEnd = source.indexOf("\n  server.listen(0, '127.0.0.1'", routeStart)
  vm.runInContext(source.slice(routeStart, routeEnd) + '\nthis.httpServer = server', lane)
  await new Promise(resolve => lane.httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${lane.httpServer.address().port}`
  try {
    const stopped = await fetch(url + '/interrupt', { method: 'POST' })
    assert.equal(stopped.status, 504, mode)
    const next = await fetch(url + '/inbound', { method: 'POST', body: JSON.stringify({ content: 'try again' }) })
    assert.equal(next.status, 200, `new inbound accepted after ${mode} failure`)
  } finally { await new Promise(resolve => lane.httpServer.close(resolve)) }
}
console.log('PASS: stop recovery over HTTP, Windows root kill, async enumeration, budgets and owned POSIX kill')

const identityKills = []
await context.kill(10, new Map([[11, 'original'], [13, 'old']]), {
  readRows: async () => [
    {pid: 11, ppid: 10, startTime: 'original', command: 'unknown transport'},
    {pid: 12, ppid: 10, startTime: 'new', command: 'tool'},
    {pid: 13, ppid: 10, startTime: 'reused', command: 'tool'}
  ], platform: 'darwin', signal: pid => identityKills.push(pid)
})
assert.deepEqual(identityKills.sort(), [12, 13], 'turn-start infrastructure survives, mid-turn tools and reused PIDs die')
assert.match(source, /turnInfrastructure = ownedProcessRows/)

const escapedWrapper = 'cmd.exe /d /s /c "npx ^"-y^" ^"@pkg/server^""'
const spacedServer = { spaced: { command: 'node', args: ['/Applications/Sera App/resources/server.mjs'] } }
assert.equal(context.isMcp({command: escapedWrapper}, wrappedServers), true, 'cross-spawn caret quotes decoded')
assert.equal(context.isMcp({command: 'node /Applications/Sera App/resources/server.mjs'}, spacedServer), true, 'flattened spaced POSIX path matched')
for (const [command, config] of [[escapedWrapper, wrappedServers], ['node /Applications/Sera App/resources/server.mjs', spacedServer]]) {
  const dead = []
  await context.kill(10, new Map(), { readRows: async () => [
    {pid: 11, ppid: 10, command}, {pid: 12, ppid: 11, command: 'server child'},
    {pid: 13, ppid: 10, command: 'mid-turn tool'}
  ], platform: 'darwin', signal: pid => dead.push(pid), isInfrastructure: row => context.isMcp(row, config) })
  assert.deepEqual(dead, [13], 'lazy transport fallback protects descendants but kills mid-turn tool')
}

const turnTime = Date.parse('2026-10-16T04:00:00Z')
const snapshotRows = [
  {pid: 11, ppid: 10, startTime: '2026-10-16T03:59:58Z', command: 'old infrastructure'},
  {pid: 12, ppid: 10, startTime: '2026-10-16T04:00:01Z', command: 'already spawned tool'},
  {pid: 13, ppid: 10, startTime: '2026-10-16T03:59:59Z', command: 'inside margin tool'},
  {pid: 14, ppid: 10, startTime: '2026-10-16T04:00:02Z', command: 'node /app/channel-local.mjs'}
]
const baseline = context.snapshot(snapshotRows, 10, turnTime)
assert.deepEqual([...baseline.keys()], [11], 'only processes predating turn minus 1.5 seconds enter baseline')
const timeKills = []
await context.kill(10, baseline, {readRows: async () => snapshotRows, platform: 'darwin',
  signal: pid => timeKills.push(pid), isInfrastructure: row => context.isMcp(row, servers)})
assert.deepEqual(timeKills.sort(), [12, 13], 'delayed snapshot tools die; old identity and new matched transport survive')
assert.equal(context.startMillis('/Date(1792123200000)/'), 1792123200000)
assert.equal(context.startMillis('Fri 16 Oct 13:00:00 2026'), Date.parse('Fri Oct 16 13:00:00 2026'))
let heartbeat = false
const slowSnapshot = new Promise(resolve => setTimeout(() => resolve(baseline), 20))
const waitSnapshot = context.bounded(slowSnapshot, 100)
await new Promise(resolve => setTimeout(() => { heartbeat = true; resolve() }, 0))
assert.equal(heartbeat, true, 'event loop services HTTP work while snapshot enumeration is pending')
assert.equal(await waitSnapshot, baseline)
assert.equal((await context.bounded(new Promise(() => {}), 5)).size, 0, 'hung snapshot is bounded')
assert.doesNotMatch(source, /execFileSync/)
assert.match(source, /const turnTime = Number.isFinite\(eventTime\) \? eventTime : receivedAt/)
