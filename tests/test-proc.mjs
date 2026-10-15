// test-proc.mjs -- proc.cjs, the one process-control seam (design-0023 P3).
// Run: node tests/test-proc.mjs
//
// Attacks, not demonstrations. The win32 lanes are exercised FROM MAC through
// the injectable platform/env/existsSync seams -- that is the whole point of
// having one module: the Windows behavior must be reviewable on the box the
// developer actually has. Anything that needs a real Windows kernel
// (taskkill, Get-CimInstance) is named in the report as unverified here, not
// faked into a green tick.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  selectSweepPids,
  isPidAlive,
  killTree,
  gracefulStop,
  resolveOnPath,
  readCommandLine,
} from '../proc.cjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IS_WIN = process.platform === 'win32'

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── resolveOnPath: PATHEXT is the win32 half nobody could test on mac ───────
console.log('\n-- resolveOnPath: fake PATH + PATHEXT (win32 lane exercised from any host)')
{
  const winFiles = new Set([
    'C:\\tools\\claude.exe',
    'C:\\tools\\node.CMD',
    'C:\\other\\claude.exe',
  ])
  const winEnv = { PATH: 'C:\\tools;C:\\other', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const win = (bin, env = winEnv) => resolveOnPath(bin, {
    env, platform: 'win32', delimiter: ';', existsSync: (f) => winFiles.has(f),
  })
  ok('win32 finds bin+.EXE for a bare name', win('claude') === 'C:\\tools\\claude.exe', String(win('claude')))
  ok('win32 finds an UPPER-case PATHEXT file on disk (node.CMD)',
    win('node') === 'C:\\tools\\node.CMD', String(win('node')))
  ok('win32 honours PATH ORDER (first dir wins)',
    win('claude').startsWith('C:\\tools'), String(win('claude')))
  ok('win32 name that already carries an extension resolves as-is',
    win('claude.exe') === 'C:\\tools\\claude.exe', String(win('claude.exe')))
  ok('win32 bare name with NO PATHEXT match -> null (a .cmd shim is not exec-able by spawn)',
    win('claude', { PATH: 'C:\\tools', PATHEXT: '.COM' }) === null)
  ok('win32 stripped PATHEXT env falls back to the default list',
    win('claude', { PATH: 'C:\\tools' }) === 'C:\\tools\\claude.exe')
  ok('empty PATH entries are skipped, not joined into ./bin',
    win('claude', { PATH: ';C:\\tools;', PATHEXT: '.EXE' }) === 'C:\\tools\\claude.exe')

  // Literal, deliberately: resolveOnPath joins in the TARGET platform's dialect
  // now, so a linux question answers in posix from any runner. Building this
  // with the host's path.join is what made it runner-dependent in the first
  // place (3eca41c), and it went red on Windows for exactly that reason.
  const POSIX_CLAUDE = '/opt/bin/claude'
  const posixFiles = new Set([POSIX_CLAUDE])
  const posix = (bin, env = { PATH: '/nope:/opt/bin' }) => resolveOnPath(bin, {
    env, platform: 'linux', delimiter: ':', existsSync: (f) => posixFiles.has(f),
  })
  ok('posix resolves a bare name with no extension games', posix('claude') === POSIX_CLAUDE, String(posix('claude')))
  ok('posix miss -> null', posix('ollama') === null)
  // Reads the SAME fixture set as the lookups above, so it has to ask with the
  // same shape the set was built with -- a literal '/opt/bin/claude' is not in a
  // path.join-built set on a Windows runner. (The 3eca41c fix rebuilt the set
  // and missed this line, which is why it went red on Windows and nowhere else.)
  ok('an explicit path is checked as given, never PATH-walked',
    resolveOnPath(POSIX_CLAUDE, { platform: 'linux', existsSync: (f) => posixFiles.has(f) }) === POSIX_CLAUDE &&
    resolveOnPath('/opt/bin/nope', { platform: 'linux', existsSync: (f) => posixFiles.has(f) }) === null)
  ok('empty/undefined bin -> null', resolveOnPath('') === null && resolveOnPath(undefined) === null)
}

// ── isPidAlive / readCommandLine ───────────────────────────────────────────
console.log('\n-- isPidAlive + readCommandLine on this host')
{
  ok('our own pid is alive', isPidAlive(process.pid))
  ok('an absurd pid is not', !isPidAlive(999999999))
  ok('garbage pids are not alive', !isPidAlive(null) && !isPidAlive(0) && !isPidAlive('x'))
  let line = ''
  try { line = readCommandLine(process.pid) } catch { /* reported below */ }
  ok('readCommandLine returns OUR OWN argv (contiguous, un-truncated)',
    line.includes('test-proc.mjs'), line.trim().slice(0, 200))
}

// ── gracefulStop: the stop contract, with a real child ─────────────────────
// Attack: (a) the stopflag is written even when the process is already gone,
// (b) a child that exits on SIGTERM is NOT force-killed, (c) a child that
// ignores SIGTERM IS force-killed after the grace window, (d) `verify`
// vetoing the force-kill leaves the process alone (the pid-recycling guard).
console.log('\n-- gracefulStop: stopflag + grace window + force')
if (IS_WIN) {
  console.log('  SKIP  gracefulStop child lanes -- POSIX signal semantics; the win32 lane needs a real Windows box (see report)')
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-stop-'))
  const stopflag = path.join(dir, '.stop_requested')
  const waitUntil = async (fn, ms) => {
    const end = Date.now() + ms
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)) }
    return fn()
  }
  // READY MARKER, not "spawn returned": isPidAlive() is true the instant the
  // node process exists, which is BEFORE it has run a line of the script --
  // so a stop issued then hits a process whose SIGTERM handler is not
  // installed yet, and the "ignores TERM" fixture dies to the default
  // disposition. The first run of this suite convicted gracefulStop of
  // skipping its grace window for exactly that reason; the grace window was
  // innocent.
  const spawnChild = async (body) => {
    const id = Math.random().toString(16).slice(2)
    const file = path.join(dir, `child-${id}.mjs`)
    const ready = path.join(dir, `ready-${id}`)
    fs.writeFileSync(file, `import fs from 'node:fs'\n${body}\nfs.writeFileSync(${JSON.stringify(ready)}, '1')\n`)
    // detached: the child leads its own group, exactly like the supervisor --
    // gracefulStop signals the GROUP, and a non-detached child would put this
    // test runner in the blast radius.
    const c = spawn(process.execPath, [file], { detached: true, stdio: 'ignore' })
    await waitUntil(() => fs.existsSync(ready), 10000)
    return c
  }

  {
    const c = await spawnChild('setTimeout(() => {}, 60000)') // default SIGTERM handling = dies
    const res = await gracefulStop(c.pid, { stopflag, graceMs: 8000, pollMs: 50 })
    ok('stopflag written', fs.existsSync(stopflag))
    ok('a TERM-honouring child stops WITHOUT the force kill', res.stopped && !res.forced, JSON.stringify(res))
    ok('and is actually dead', !isPidAlive(c.pid))
    fs.rmSync(stopflag, { force: true })
  }

  {
    // Ignores TERM: only SIGKILL ends it. graceMs short so the test is fast.
    const c = await spawnChild("process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)")
    const t0 = Date.now()
    const res = await gracefulStop(c.pid, { stopflag, graceMs: 1000, pollMs: 50 })
    ok('a TERM-ignoring child is force-killed after the grace window', res.forced === true, JSON.stringify(res))
    ok('the grace window was actually waited out (not an instant kill)', Date.now() - t0 >= 950, `${Date.now() - t0}ms`)
    ok('and it is dead', await waitUntil(() => !isPidAlive(c.pid), 3000))
    fs.rmSync(stopflag, { force: true })
  }

  {
    // verify() vetoes the force kill -- the pid-recycled guard. The child
    // survives, which is the POINT: never SIGKILL an unconfirmed pid.
    const c = await spawnChild("process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)")
    const res = await gracefulStop(c.pid, { stopflag, graceMs: 600, pollMs: 50, verify: () => false })
    ok('verify()=false refuses the force kill', res.forced === false && res.stopped === false, JSON.stringify(res))
    ok('the unconfirmed pid is left alive', isPidAlive(c.pid))
    try { killTree(c.pid, 'SIGKILL') } catch {}
    fs.rmSync(stopflag, { force: true })
  }

  {
    // Already dead: still writes the flag (the belt the supervisor loop reads)
    // and reports stopped without touching a pid that is not there.
    const res = await gracefulStop(999999999, { stopflag, graceMs: 100 })
    ok('a dead pid stops immediately and still leaves the stopflag',
      res.stopped && !res.forced && fs.existsSync(stopflag), JSON.stringify(res))
  }

  {
    // The WIN32 BRANCH, exercised from mac through the injectable platform.
    // On Windows there is no deliverable signal (process.kill is
    // TerminateProcess), so gracefulStop must NOT signal at all -- it writes
    // the stopflag, waits out the SAME grace window while the lane's own poll
    // runs its shutdown(), and only then force-kills. The fixture here dies to
    // a default SIGTERM, so "still alive when the window expires" is proof
    // that no TERM was sent; forced:true is proof the window ended in a kill
    // rather than a hang. (The kill itself is POSIX here -- killTree reads the
    // REAL platform -- so this covers the ORDER, not taskkill. taskkill on a
    // live CLI+MCP tree remains owed from the Windows box; see the report.)
    const c = await spawnChild('setTimeout(() => {}, 60000)')
    const t0 = Date.now()
    const res = await gracefulStop(c.pid, { stopflag, graceMs: 1200, pollMs: 50, platform: 'win32' })
    ok('win32 lane waits the FULL grace window instead of killing on contact',
      Date.now() - t0 >= 1150, `${Date.now() - t0}ms`)
    ok('win32 lane sent no signal (a TERM-honouring child survived the window)', res.forced === true, JSON.stringify(res))
    ok('win32 lane still wrote the stopflag -- the only stop channel that OS has', fs.existsSync(stopflag))
    ok('and the process is gone after it', await waitUntil(() => !isPidAlive(c.pid), 3000))
    fs.rmSync(stopflag, { force: true })
  }

  {
    // killTree reaches a GRANDCHILD through the process group -- the property
    // main.cjs's quit path and the supervisor's stop both rely on.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-tree-'))
    const marker = path.join(dir2, 'grandchild.pid')
    const src = `import { spawn } from 'node:child_process'\n` +
      `const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })\n` +
      `fs.writeFileSync(${JSON.stringify(marker)}, String(g.pid))\n` +
      `process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)`
    const c = await spawnChild(src)
    await waitUntil(() => fs.existsSync(marker), 8000)
    const gpid = Number(fs.readFileSync(marker, 'utf8').trim())
    ok('grandchild is alive before the group kill', isPidAlive(gpid))
    killTree(c.pid, 'SIGKILL')
    ok('killTree(-pid) reaped the GRANDCHILD too', await waitUntil(() => !isPidAlive(gpid), 5000))
    fs.rmSync(dir2, { recursive: true, force: true })
  }

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── the copies are actually gone ───────────────────────────────────────────
// The reason this module exists is that four files each carried their own
// taskkill/ps/lsof. A resurrected copy fails here, loudly, in the same commit
// that writes it.
console.log('\n-- no second copy of the process-control primitives')
{
  const sources = {
    'main.cjs': fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8'),
    'supervisor.mjs': fs.readFileSync(path.join(ROOT, 'supervisor.mjs'), 'utf8'),
    'onboarding/http-server.cjs': fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8'),
    'onboarding/ollama-daemon.cjs': fs.readFileSync(path.join(ROOT, 'onboarding', 'ollama-daemon.cjs'), 'utf8'),
  }
  // Match CALL SITES, not prose: every one of these files legitimately talks
  // about the primitives in comments now that it delegates them.
  for (const [name, src] of Object.entries(sources)) {
    ok(`${name}: no local taskkill call`, !src.includes("'taskkill'"))
    ok(`${name}: no local CIM command-line read`, !src.includes('Get-CimInstance Win32_Process'))
    ok(`${name}: no local lsof/ps port-owner exec`,
      !src.includes("execFileSync('/usr/sbin/lsof'") && !src.includes("'-iTCP:"))
    ok(`${name}: no local process-group kill`, !/process\.kill\(-/.test(src))
    ok(`${name}: pulls the primitives from proc.cjs`, /(require\(['"][^'"]*proc\.cjs['"]\))|(from '\.\/proc\.cjs')/.test(src))
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  ok('proc.cjs ships (build.files)', pkg.build.files.includes('proc.cjs'))
  ok('proc.cjs is a REAL file on disk (asarUnpack) -- supervisor.mjs runs unpacked',
    pkg.build.asarUnpack.includes('proc.cjs'))
}

// Two profiles share the install path, never the ownership path.
{
  const home = String.raw`C:\Users\minom\Documents\Scheherazade`
  const other = home + '-mitil'
  const script = String.raw`C:\Program Files\Scheherazade\dsh-lane.mjs`
  const rows = [
    { ProcessId: 101, CommandLine: `Scheherazade.exe "${script}" --data-home "${home}"` },
    { ProcessId: 102, CommandLine: `Scheherazade.exe "${script}" --data-home "${other}"` },
    { ProcessId: 103, CommandLine: `node ${script} --data-home ${home}` },
    { ProcessId: 104, CommandLine: `node ${script} --data-home ${other}` },
    { ProcessId: 105, CommandLine: 'Scheherazade.exe' },
    { ProcessId: 106, CommandLine: `node "${script}"` },
  ]
  const select = (dataHome, pattern = script, input = rows) => selectSweepPids(input, pattern, { dataHome, platform: 'win32', ownPid: 999 })
  ok('default sweep selects only own quoted/unquoted lane pids', JSON.stringify(select(home)) === '[101,103]')
  ok('mitil spawn sweep never selects default or unrelated exe', JSON.stringify(select(other)) === '[102,104]')
  ok('missing profile identity fails closed', select(undefined).length === 0)
  ok('Windows path matching is case insensitive', select(home.toUpperCase()).length === 2)
  ok('own pid excluded', selectSweepPids(rows, script, { dataHome: home, platform: 'win32', ownPid: 101 }).join() === '103')
  for (const filename of ['lane.runtime.patch.yml', 'lane.patch.yml', '.mcp.json']) {
    const suffix = filename === '.mcp.json' ? filename : `.dsh-lane-home\\${filename}`
    const option = filename === '.mcp.json' ? '--mcp-config' : '--patch'
    const leaves = [home, other].flatMap((h, i) => [
      { ProcessId: 200 + i, CommandLine: `node engine ${option} "${h}\\${suffix}"` },
      { ProcessId: 300 + i, CommandLine: `node engine ${option} ${h}\\${suffix}` },
    ])
    ok(`quoted/unquoted ${filename} leaves stay profile scoped`, select(home, `${option} ${home}\\${suffix}`, leaves).join() === '200,300')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
