import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { spawn, spawnSync, execFileSync } from 'node:child_process'

const source = fs.readFileSync(new URL('../dsh-lane.mjs', import.meta.url), 'utf8')
const start = source.indexOf('export function createTurnControl')
const end = source.indexOf('export function killOwnedTools', start)
const context = { setTimeout, clearTimeout }
vm.createContext(context)
vm.runInContext(source.slice(start, end).replaceAll('export function', 'function') + '\nthis.create = createTurnControl; this.roots = toolProcessRoots', context)
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
assert.match(patch, /await agent.whenIdle\(\)/)
const gateway = fs.readFileSync(new URL('../node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js', import.meta.url), 'utf8')
const patched = gateway.includes('agent.cancel({ kind: "user" }, { keepInbox: false });') ? gateway : gateway.replace('cancel(request) {\n\t\t\t\tconst { sessionId }', 'async cancel(request) {\n\t\t\t\tconst { sessionId }').replace('agent.cancel({ kind: "user" }, { keepInbox: true });', 'agent.cancel({ kind: "user" }, { keepInbox: false });\n\t\t\t\tawait agent.whenIdle();')
const method = patched.slice(patched.indexOf('async cancel(request) {'), patched.indexOf('\n\t\t},\n\t\tsubagents:', patched.indexOf('async cancel(request) {'))).trim()
let inbox = ['queued']; let wake = true; let aborted = false; let idle
const agent = { session: {}, cancel (_cause, options) { aborted = true; if (!options.keepInbox) { inbox = []; wake = false } }, whenIdle: () => new Promise(resolve => { idle = resolve }) }
const sandbox = { ctx: { agents: new Map([['s', agent]]) }, hasSubagentOwner: () => false, ok: (_req, value) => value, err: () => { throw new Error('unexpected error') } }
vm.createContext(sandbox)
vm.runInContext('this.handler = ({' + method + '})', sandbox)
const outcome = sandbox.handler.cancel({ payload: { sessionId: 's' } })
assert.equal(aborted, true); assert.deepEqual(inbox, []); assert.equal(wake, false)
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
    const killStart = source.indexOf('function ownedProcessRows')
    const killEnd = source.indexOf('// ── engine boot', killStart)
    const killContext = { process, execFileSync, Set }
    vm.createContext(killContext)
    vm.runInContext(source.slice(start, end).replaceAll('export function', 'function') +
      source.slice(killStart, killEnd).replaceAll('export function', 'function') + '\nthis.kill = killOwnedTools', killContext)
    killContext.kill(engine.pid)
    process.kill(engine.pid, 0)
    let alive = true
    for (let i = 0; i < 50 && alive; i++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      try { process.kill(toolPid, 0) } catch { alive = false }
    }
    assert.equal(alive, false, 'owned tool exits, engine survives')
  } finally { engine.kill('SIGKILL') }
}
console.log('PASS: immediate stop, awaited failure/timeout, inbox+wakes, generation, budgets, thinking-only guard, owned POSIX kill')
