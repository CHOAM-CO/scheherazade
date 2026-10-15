// proc.cjs -- ONE process-control seam for mac, Windows and Linux.
//
// Before design-0023 P3 the same five operations lived in five hand-copied
// forms of differing quality: main.cjs (killTree + a `ps`/CIM identity read),
// supervisor.mjs (the best copy -- absolute powershell path, the $PID
// self-exclusion fix, taskkill /T), onboarding/http-server.cjs (killTree),
// onboarding/ollama-daemon.cjs (killTree + a mac-only /usr/sbin/lsof port
// owner lookup). A Linux fix therefore meant editing four files and getting
// four different reviews. Everything below is the UNION of those copies with
// their receipts kept; no behavior was "improved" while moving it.
//
// Plain CJS, no Electron: required from main.cjs / the onboarding server, and
// imported from ESM (supervisor.mjs) as a default+named import.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const IS_WIN = process.platform === 'win32'

// Absolute powershell path (2026-08-13, the Windows box log: "orphan sweep failed
// (spawnSync powershell.exe ENOENT)"). Callers spawn with a scrubbed PATH, and
// Windows does not guarantee System32 is on it. A bare 'powershell.exe' then
// ENOENTs and the CommandLine read + orphan sweep both silently no-op. Resolve
// against %SystemRoot% when we can; fall back to the bare name (which still
// works wherever PATH is intact) so a missing env var never makes this worse.
const POWERSHELL_EXE = IS_WIN
  ? (process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe')
  : 'powershell.exe'

// EPERM = alive but not ours to signal (a different uid): still ALIVE.
function isPidAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

// Full, un-truncated command line of a pid, or '' when it cannot be read.
// posix: `-ww` forces ps to print the WHOLE line -- stock BSD/macOS ps
// width-limits `command=`, and a supervisor launched from a long install path
// (inside a *.app bundle) gets its `__loop` truncated clean off, which
// false-negates a REAL supervisor (run.sh:126-174's Fix A, same receipt).
// win32: Get-CimInstance, VERIFIED BY EXECUTION 2026-08-01 on the Windows box
// (3 runs, 268/295/405 ms, CommandLine present and matching).
// Throws on failure -- every caller here treats a throw as "not verified".
function readCommandLine(pid) {
  if (IS_WIN) {
    return execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout: 2000 }).trim()
  }
  return execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 })
}

// Kill a pid AND its descendants.
// posix: negative-pid group signal (callers spawn detached, so the target is
// its own group leader). ESRCH on the group = no such group; fall back to the
// lone pid rather than reporting a kill that never happened.
// win32: no process groups exist, so every negative-pid call used to throw
// straight into its catch and kill NOTHING -- detached login flows and MCP
// grandchildren survived app quit as orphans (found 2026-08-03). taskkill /T
// is the equivalent; /F because a detached console child will not honour a
// polite close.
function killTree(pid, signal = 'SIGTERM') {
  if (IS_WIN) {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-Number(pid), signal)
  } catch (err) {
    if (err.code !== 'ESRCH') throw err
    process.kill(Number(pid), signal)
  }
}

// Fail closed: a shared install/script path is never process ownership.
// Paths may be quoted or unquoted in CIM/ps; require a path boundary so
// Scheherazade cannot select Scheherazade-mitil or ScheherazadeBackup.
function selectSweepPids(rows, pattern, { dataHome, platform = process.platform, ownPid = process.pid } = {}) {
  if (!dataHome || !pattern) return []
  const normalize = (s) => platform === 'win32' ? String(s).replace(/\\/g, '/').toLowerCase() : String(s)
  const scope = normalize(dataHome).replace(/\/$/, '')
  const needle = normalize(pattern)
  return rows.filter((row) => {
    const pid = Number(row.ProcessId)
    if (!Number.isInteger(pid) || pid <= 0 || pid === Number(ownPid)) return false
    const cmd = normalize(row.CommandLine || '')
    if (!cmd.replace(/["']/g, '').includes(needle.replace(/["']/g, ''))) return false
    let at = cmd.indexOf(scope)
    while (at >= 0) {
      const before = cmd[at - 1]
      const after = cmd[at + scope.length]
      if ((!before || /[\s"'=]/.test(before)) && (!after || /[\s"'/]/.test(after))) return true
      at = cmd.indexOf(scope, at + 1)
    }
    return false
  }).map((row) => Number(row.ProcessId))
}

function sweepByPattern(pattern, { dataHome, log = () => {} } = {}) {
  if (!dataHome) return // never fall back to a global pattern kill
  try {
    let rows
    if (IS_WIN) {
      // No pattern/path interpolated into PowerShell: the enumerator cannot
      // match itself, and all selection happens in the tested JS seam.
      const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
        { encoding: 'utf8', timeout: 5000 })
      const parsed = JSON.parse(out || '[]')
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } else {
      const out = execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 })
      rows = out.split('\n').flatMap((line) => {
        const m = line.match(/^\s*(\d+)\s+(.*)$/)
        return m ? [{ ProcessId: Number(m[1]), CommandLine: m[2] }] : []
      })
    }
    for (const pid of selectSweepPids(rows, pattern, { dataHome })) {
      // Re-read immediately before signalling: fail closed on recycled pids.
      const cmd = readCommandLine(pid)
      if (!selectSweepPids([{ ProcessId: pid, CommandLine: cmd }], pattern, { dataHome }).length) continue
      log(`orphan sweep: stopping pid ${pid} under ${dataHome}`)
      try { process.kill(pid, 'SIGTERM') } catch (err) { if (err.code !== 'ESRCH') log(`orphan pid ${pid}: ${err.message}`) }
    }
  } catch (err) {
    log(`orphan sweep failed (${err.message}) -- continuing`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Stop a process tree and give its own shutdown path a chance to run first.
// ONE contract, two mechanisms, because the platforms differ in what "ask
// politely" even means:
//   posix -- STOPFLAG (the belt: a lost signal still ends the supervisor loop
//     at its next iteration) + SIGTERM to the process GROUP, so the lane's own
//     SIGTERM handler runs and reaps the engine; then up to graceMs of polling;
//     then SIGKILL.
//   win32 -- there is no deliverable signal (process.kill is TerminateProcess:
//     no handler runs, the child would orphan), so the STOPFLAG file IS the
//     signal. The lane polls it and runs its shutdown(); the supervisor loop
//     sees it at its post-exit check. We wait out the same grace window and
//     only then taskkill /T /F, instead of hard-killing the tree immediately
//     (which is what shipped before P3 -- dsh-lane's shutdown() and
//     headless-lane's SIGTERM handler never ran on Windows at all).
// `verify` is the identity re-check before the HARD kill: graceMs can elapse,
// the pid die, and the OS recycle it to an unrelated process. Fail safe --
// only force-kill a pid still confirmed as ours.
async function gracefulStop(pid, {
  stopflag = null,
  graceMs = 15_000,
  pollMs = 250,
  signal = 'SIGTERM',
  verify = null,
  log = () => {},
  platform = process.platform,
} = {}) {
  const isWin = platform === 'win32'
  if (stopflag) {
    try { fs.writeFileSync(stopflag, '') } catch (err) { log(`stopflag write failed (${err.message}) -- continuing with the signal path`) }
  }
  if (!isPidAlive(pid)) return { stopped: true, forced: false }
  if (!isWin) {
    try { killTree(pid, signal) } catch (err) { if (err.code !== 'ESRCH') log(`group ${signal} failed (${err.message})`) }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return { stopped: true, forced: false }
    await sleep(pollMs)
  }
  if (!isPidAlive(pid)) return { stopped: true, forced: false }
  if (verify && !verify(pid)) {
    log(`pid ${pid} no longer identifies as ours (exited and recycled?) -- skipping force-kill of an unconfirmed pid`)
    return { stopped: false, forced: false }
  }
  log('did not stop in time, forcing')
  try { killTree(pid, 'SIGKILL') } catch (err) { log(`force kill failed (${err.message})`) }
  return { stopped: !isPidAlive(pid), forced: true }
}

// Resolve a bare binary name against PATH; an absolute/relative path is
// checked as given. win32 honours PATHEXT (a bare `claude` there is not
// executable -- `claude.exe`/`claude.cmd` is), and the extension is tried in
// both cases because PATHEXT is upper-case by convention while what is on
// disk usually is not. Injectable env/platform/existsSync so the win32 lane
// is testable from mac (tests/test-proc.mjs).
function resolveOnPath(bin, {
  env = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  delimiter = null,
} = {}) {
  if (!bin) return null
  const isWin = platform === 'win32'
  // Join in the TARGET platform's dialect, not the running host's. `platform`
  // is process.platform in every production call, so this is the same thing
  // path.join already did there -- but the injected-platform seam the tests use
  // crosses hosts, and a bare path.join answered '\evil\codex' when a Windows
  // runner asked a linux question. Same fix, and same reason, as platform.cjs's
  // binDirsFor. (Found by running the suite on the Windows box, not here.)
  const P = isWin ? path.win32 : path.posix
  const sep = delimiter || (isWin ? ';' : ':')
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin) ? bin : null
  const exts = isWin ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const alreadyExt = isWin && exts.some((e) => bin.toLowerCase().endsWith(e.toLowerCase()))
  for (const dir of String(env.PATH || '').split(sep)) {
    if (!dir) continue
    const candidates = alreadyExt ? [bin] : []
    for (const ext of exts) {
      if (!ext) { candidates.push(bin); continue }
      candidates.push(bin + ext.toLowerCase(), bin + ext)
    }
    for (const cand of candidates) {
      const full = P.join(dir, cand)
      if (existsSync(full)) return full
    }
  }
  return null
}

// Pids listening on a TCP port. Used for port-owner diagnostics only.
// mac: /usr/sbin/lsof (absolute -- a packaged app's PATH is the launchd
// default). linux: lsof is /usr/bin/lsof on most distros and absent on many,
// so try PATH lsof and fall back to `ss -ltnp`. win32: Get-NetTCPConnection.
// Any failure = [] (unknown), never a throw: every caller is fail-closed on
// an empty list already.
function listenerPids(port) {
  const p = Number(port)
  if (!Number.isFinite(p) || p <= 0) return []
  const uniq = (out) => [...new Set(String(out).split('\n').map((s) => s.trim()).filter(Boolean))]
  try {
    if (IS_WIN) {
      return uniq(execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command',
        `Get-NetTCPConnection -LocalPort ${p} -State Listen | Select-Object -ExpandProperty OwningProcess`],
        { encoding: 'utf8', timeout: 5000 }))
    }
    const lsof = process.platform === 'darwin' ? '/usr/sbin/lsof' : (resolveOnPath('lsof') || '/usr/bin/lsof')
    return uniq(execFileSync(lsof, ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 3000 }))
  } catch {
    if (IS_WIN) return []
    // linux fallback: `ss -ltnp` prints `users:(("name",pid=123,fd=7))`.
    try {
      const ss = resolveOnPath('ss')
      if (!ss) return []
      const out = execFileSync(ss, ['-ltnp'], { encoding: 'utf8', timeout: 3000 })
      const pids = []
      for (const line of out.split('\n')) {
        if (!new RegExp(`[:.]${p}\\s`).test(line)) continue
        for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(m[1])
      }
      return [...new Set(pids)]
    } catch { return [] }
  }
}

// Executable path a pid was launched as. Used by the ollama adopt-a-daemon
// identity check. mac: `ps -o comm=` reports the un-truncated executable path
// (unlike args-derived guesses). linux: procps `comm=` is the SHORT name, so
// read /proc/<pid>/exe instead. win32: Get-Process .Path.
function execPathOfPid(pid) {
  try {
    if (IS_WIN) {
      const out = execFileSync(POWERSHELL_EXE, ['-NoProfile', '-Command',
        `(Get-Process -Id ${Number(pid)}).Path`], { encoding: 'utf8', timeout: 5000 })
      return out.trim() || null
    }
    if (process.platform === 'linux') {
      try { return fs.readlinkSync(`/proc/${Number(pid)}/exe`) || null } catch { /* fall through to ps */ }
    }
    const out = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 3000 })
    return out.trim() || null
  } catch {
    return null
  }
}

module.exports = {
  POWERSHELL_EXE,
  isPidAlive,
  readCommandLine,
  killTree,
  sweepByPattern,
  selectSweepPids,
  gracefulStop,
  resolveOnPath,
  listenerPids,
  execPathOfPid,
}
