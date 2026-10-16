import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { spawn, spawnSync, execFileSync, execFile } from 'node:child_process'

const source = fs.readFileSync(new URL('../dsh-lane.mjs', import.meta.url), 'utf8')
const start = source.indexOf('export function createTurnControl')
const end = source.indexOf('// ── engine boot', start)
const context = { setTimeout, clearTimeout, process, execFileAsync: promisify(execFile), require: () => ({ POWERSHELL_EXE: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' }) }
vm.createContext(context)
vm.runInContext(source.slice(start, end).replaceAll('export ', '') + '\nthis.create = createTurnControl; this.roots = toolProcessRoots; this.kill = killOwnedTools; this.rows = ownedProcessRows', context)
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
for (let i = 0; i < 60; i++) assert.equal(control.tool(), 0)
assert.equal(control.tool(), 60)
control.begin(true)
for (let i = 0; i < 12; i++) assert.equal(control.tool(), 0)
assert.equal(control.tool(), 12, 'boot budget is lower')
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
assert.match(source, /const exceeded = control.tool\(\)/)
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
// Windows-shaped test runs on every host and simulates an already-dead root.
const taskkills = []
await context.kill(10, new Set([11]), {
  platform: 'win32',
  readRows: async () => [{ pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 12 }, { pid: 14, ppid: 11 }],
  run: async (_command, args) => { taskkills.push(Number(args[1])); throw Object.assign(new Error('already gone'), { code: 128 }) }
})
assert.deepEqual(taskkills.sort(), [12, 14], 'only taskkill roots, tolerate dead pids')
let enumCommand
await context.rows({ platform: 'win32', powershell: 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', run: async (command, _args, options) => {
  enumCommand = command; assert.equal(options.timeout, 10000)
  return { stdout: '{"ProcessId":42,"ParentProcessId":10,"CommandLine":"node channel-local.mjs"}' }
} })
assert.match(enumCommand, /System32/)

// Real HTTP requests drive the actual lane ingest handler, not a fake route.
// Each failure mode must allow the next inbound through, including Windows kill errors.
for (const mode of ['cancel', 'timeout', 'fifo', 'kill']) {
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
    cancel: () => mode === 'cancel' ? Promise.reject(new Error('cancel failed')) : mode === 'timeout' ? new Promise(() => {}) : Promise.resolve(),
    clearPending: () => mode !== 'fifo',
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
