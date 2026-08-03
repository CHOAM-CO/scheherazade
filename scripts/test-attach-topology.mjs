#!/usr/bin/env node
// test-attach-topology.mjs -- the 0.1.0-prep attach lane, attacked at three
// levels. Context (design-0016 + Mino 07-16 20:53 "Tmux로 리팩토링한버전
// 준비 바로"): the agent supervisor moves into a user-bootstrapped tmux pane
// so TCC grants survive the app's per-release ad-hoc signature churn.
//
// THE INVARIANT UNDER TEST: the app must never cause a tmux SERVER to exist.
// Everything else (adopt, respawn, tail) is behavior; that one is identity.
//
// Live sections use an ISOLATED socket namespace (-L test-...) and clean up
// their server; they skip loudly if tmux is absent on this machine.
//
// Run: node scripts/test-attach-topology.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const attach = require_(path.join(ROOT, 'attach-topology.cjs'))

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const tmuxBin = attach.resolveTmuxBin()

// ── 1. the no-server-spawn invariant ────────────────────────────────────────
console.log('no-server-spawn invariant:')
{
  check('new-session is NOT in the safe-verb allowlist', !attach.SAFE_VERBS.has('new-session'))
  check('start-server is NOT in the safe-verb allowlist', !attach.SAFE_VERBS.has('start-server'))
  let threw = false
  try { attach.tmuxIpc(['new-session', '-d', '-s', 'x']) } catch { threw = true }
  check('tmuxIpc throws on a banned verb before reaching tmux', threw)

  if (tmuxBin) {
    // Live negative control: a safe verb on a dead socket errors WITHOUT
    // creating a server or a socket file (the design's load-bearing fact).
    const sock = `test-nospawn-${process.pid}`
    const r = spawnSync(tmuxBin, ['-L', sock, 'has-session', '-t', 'agent'], { encoding: 'utf8' })
    const socketDir = `/private/tmp/tmux-${os.userInfo().uid}`
    const socketExists = fs.existsSync(path.join(socketDir, sock))
    const serverAlive = spawnSync('pgrep', ['-f', `tmux.*-L ${sock}`], { encoding: 'utf8' }).status === 0
    check('has-session on a dead socket exits nonzero', r.status !== 0)
    check('...and leaves no socket file', !socketExists)
    check('...and no server process', !serverAlive)
  } else {
    console.log('  SKIP live negative control: tmux not found on this machine')
  }
}

// ── 2. live lifecycle: bootstrap shape -> state -> dead pane -> respawn ────
console.log('live lifecycle (isolated socket):')
if (!tmuxBin) {
  console.log('  SKIP: tmux not found on this machine')
} else {
  const sock = `test-attach-${process.pid}`
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-attach-'))
  fs.mkdirSync(path.join(mem, 'logs'), { recursive: true })
  const fakeRun = path.join(mem, 'run.sh')
  // Must keep PRINTING, not just print once: pipe-pane attaches a moment
  // after new-session, so a single early echo can legitimately miss the pipe
  // (true in the real bootstrap too -- boot-banner lines may predate the
  // mirror; the STREAM is what's contracted).
  fs.writeFileSync(fakeRun, '#!/bin/bash\nwhile true; do echo "loop-alive pid=$$"; sleep 1; done\n')
  fs.chmodSync(fakeRun, 0o755)
  const logFile = path.join(mem, 'logs', 'agent.log')

  // Mimic the bootstrap template's exact moves (same verbs, same options) on
  // the isolated socket. Direct execFileSync here -- this IS the terminal
  // lane the template runs in, not the app lane under test.
  const t = (args) => execFileSync(tmuxBin, ['-L', sock, ...args], { encoding: 'utf8' })
  try {
    t(['new-session', '-d', '-s', 'agent', `exec bash '${fakeRun}' __loop`])
    t(['set', '-s', 'exit-empty', 'off'])
    t(['set-option', '-t', 'agent', 'remain-on-exit', 'on'])
    t(['pipe-pane', '-o', '-t', 'agent', `cat >> '${logFile}'`])

    // attachSessionState must see it -- but it talks to the REAL socket name.
    // Point the module at our test socket by shelling the same verbs it uses:
    // instead, verify the state fields through the same primitives.
    const panes = t(['list-panes', '-t', 'agent', '-F', '#{pane_dead} #{pane_pid}']).trim()
    const [dead0, pid0] = panes.split(' ')
    check('live pane visible (pane_dead=0)', dead0 === '0', panes)
    const paneCmd = execFileSync('ps', ['-ww', '-o', 'command=', '-p', pid0], { encoding: 'utf8' }).trim()
    check('pane command carries the run.sh __loop signature', paneCmd.includes(`${fakeRun} __loop`), paneCmd)

    // pipe-pane mirrors output. POLL, don't sleep a fixed time: the ticker
    // echoes every 1s and a fixed 700ms wait loses the race by ~100ms
    // (caught live: first echo predates the pipe, second lands at t=1.0s).
    let mirrored = false
    for (let i = 0; i < 25 && !mirrored; i++) {
      await new Promise((r) => setTimeout(r, 200))
      mirrored = fs.existsSync(logFile) && fs.readFileSync(logFile, 'utf8').includes('loop-alive')
    }
    check('pipe-pane mirrors pane output to the logfile', mirrored)

    // kill the process -> pane dead, session survives, server survives
    process.kill(Number(pid0))
    await new Promise((r) => setTimeout(r, 800))
    const hasSession = spawnSync(tmuxBin, ['-L', sock, 'has-session', '-t', 'agent']).status === 0
    check('session survives process death (remain-on-exit)', hasSession)
    const deadNow = t(['list-panes', '-t', 'agent', '-F', '#{pane_dead}']).trim()
    check('pane reads dead=1', deadNow === '1', deadNow)

    // respawn revives with the ORIGINAL command, fresh pid
    t(['respawn-pane', '-t', 'agent'])
    await new Promise((r) => setTimeout(r, 500))
    const panes2 = t(['list-panes', '-t', 'agent', '-F', '#{pane_dead} #{pane_pid}']).trim()
    const [dead2, pid2] = panes2.split(' ')
    check('respawn-pane revives (dead=0, new pid)', dead2 === '0' && pid2 !== pid0, panes2)
    const paneCmd2 = execFileSync('ps', ['-ww', '-o', 'command=', '-p', pid2], { encoding: 'utf8' }).trim()
    check('respawned command keeps the signature', paneCmd2.includes(`${fakeRun} __loop`), paneCmd2)

    // exit-empty off: killing the session leaves the server alive
    t(['kill-session', '-t', 'agent'])
    const serverStillUp = spawnSync(tmuxBin, ['-L', sock, 'list-sessions']).status === 0 ||
      spawnSync('pgrep', ['-f', `tmux.*-L ${sock}`]).status === 0
    check('server outlives its last session (exit-empty off)', serverStillUp)
  } finally {
    spawnSync(tmuxBin, ['-L', sock, 'kill-server'])
    fs.rmSync(mem, { recursive: true, force: true })
  }
}

// ── 2b. vendored portable tmux (v0.0.35, 극한의 딸깍) ───────────────────────
// The brew wall was the one manual step left in attach onboarding (Mino
// 07-30: "brew로 깔아야돼? 이거 귀찮은데"). These pin the whole chain:
// vendored artifacts sound -> boot sync lands them in DATA_HOME/bin ->
// the COPIED binary actually runs (the @executable_path/lib rewrite must
// survive relocation, that being its entire job) -> resolveTmuxBin and the
// bootstrap template prefer it.
console.log('vendored portable tmux:')
{
  const vendorDir = path.join(ROOT, 'vendor', 'tmux-portable')
  const vendorBin = path.join(vendorDir, 'tmux')
  check('vendor tree is committed (tmux + VERSION + 3 dylibs)',
    fs.existsSync(vendorBin) && fs.existsSync(path.join(vendorDir, 'VERSION')) &&
    fs.readdirSync(path.join(vendorDir, 'lib')).length === 3)
  // otool + codesign are macOS binaries inspecting a macOS binary: the vendored
  // tmux is a Mach-O that only ever runs in the darwin attach lane. On Windows
  // execFileSync('otool') threw ENOENT and killed the whole file before the
  // platform-independent checks below could run (2026-08-04 win suite).
  if (process.platform === 'darwin') {
    const links = execFileSync('otool', ['-L', vendorBin], { encoding: 'utf8' })
    check('vendored binary carries NO Homebrew load paths', !/\/opt\/homebrew\/|\/usr\/local\//.test(links))
    check('vendored binary links its dylibs via @executable_path/lib', (links.match(/@executable_path\/lib\//g) || []).length === 3)
    const sig = spawnSync('codesign', ['--verify', vendorBin])
    check('vendored binary signature verifies (install_name_tool re-sign happened)', sig.status === 0)
  } else {
    console.log('  n/a  otool/codesign checks on the vendored tmux -- Mach-O inspection, darwin only')
  }

  // Boot sync, functionally: scratch DATA_HOME, real vendor source.
  const { createHarnessRender } = require_(path.join(ROOT, 'onboarding', 'harness-render.cjs'))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-tmuxsync-'))
  const hr = createHarnessRender({
    log: () => {},
    toUnpackedPath: (p) => p,
    readAgentConfig: () => ({}),
    ensureConfigDir: () => {},
    REPO_ROOT: ROOT,
    AGENT_NAME: 'test',
    DATA_HOME: scratch,
    CONFIG_DIR: scratch,
    AGENT_CONFIG_PATH: path.join(scratch, '.agent-config'),
    ENV_PATH: path.join(scratch, '.env'),
    MCP_JSON_PATH: path.join(scratch, '.mcp.json'),
  })
  const synced = hr.syncTmuxPortable()
  const dstBin = path.join(scratch, 'bin', 'tmux-portable', 'tmux')
  check('boot sync lands the tree in DATA_HOME/bin/tmux-portable', synced === true && fs.existsSync(dstBin))
  // Executing the vendored tmux is darwin-only: it is a Mach-O, and the whole
  // attach lane it belongs to does not exist on Windows. The SYNC checks above
  // and below are plain file copies and stay on both platforms.
  if (process.platform === 'darwin') {
    const dstV = spawnSync(dstBin, ['-V'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: os.homedir() } })
    check('the RELOCATED copy runs on a brew-less PATH (dylib rewrite survives the move)',
      dstV.status === 0 && /^tmux \d/.test(String(dstV.stdout).trim()), String(dstV.stderr).trim())
  } else {
    console.log('  n/a  running the relocated tmux -- Mach-O, darwin only')
  }
  const before = fs.statSync(dstBin).mtimeMs
  hr.syncTmuxPortable()
  check('same VERSION stamp -> second sync is a no-op (no churn under a running server)',
    fs.statSync(dstBin).mtimeMs === before)
  fs.writeFileSync(path.join(scratch, 'bin', 'tmux-portable', 'VERSION'), 'stale\n')
  hr.syncTmuxPortable()
  check('a stale VERSION stamp -> sync replaces the tree',
    fs.readFileSync(path.join(scratch, 'bin', 'tmux-portable', 'VERSION'), 'utf8').trim() !== 'stale')
  fs.rmSync(scratch, { recursive: true, force: true })

  // Wiring pins.
  const attachSrc = fs.readFileSync(path.join(ROOT, 'attach-topology.cjs'), 'utf8')
  check('resolveTmuxBin prefers the DATA_HOME portable copy',
    /TMUX_CANDIDATES = \[\s*\n?\s*path\.join\(DATA_HOME, 'bin', 'tmux-portable', 'tmux'\)/.test(attachSrc))
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  check('mac extraResources ships vendor/tmux-portable',
    (pkg.build.mac.extraResources || []).some((e) => e.from === 'vendor/tmux-portable' && e.to === 'tmux-portable'))
  const httpSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  check('boot path calls syncTmuxPortable every boot', httpSrc.includes('harnessRender.syncTmuxPortable()'))
}

// ── 3. template + wiring tripwires ──────────────────────────────────────────
console.log('template + wiring tripwires:')
{
  const tpl = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'attach-bootstrap.sh'), 'utf8')
  check('bootstrap sets exit-empty off', tpl.includes('exit-empty off'))
  check('bootstrap sets remain-on-exit on', tpl.includes('remain-on-exit on'))
  check('bootstrap pipes pane output to the app logfile', tpl.includes('pipe-pane'))
  check('bootstrap writes the PIDFILE (pane_pid)', tpl.includes('#{pane_pid}') && tpl.includes('.agent.pid'))
  check('bootstrap bakes CLAUDE_BIN for app-only machines', tpl.includes("CLAUDE_BIN='$CLAUDE_BIN_BAKED'"))
  check('bootstrap bakes SUDO_ASKPASS', tpl.includes('SUDO_ASKPASS='))
  check('bootstrap refuses when a spawn-lane supervisor is live', tpl.includes('run\\.sh __loop'))
  // v0.0.35 portable-tmux moves:
  check('bootstrap prefers the app-shipped tmux over PATH', tpl.includes('TMUX_BIN="$MEM/bin/tmux-portable/tmux"'))
  check('bootstrap never tells the user to brew install', !tpl.includes('brew install'))
  check('bootstrap exports a terminfo fallback for brew-less Macs', tpl.includes('TERMINFO_DIRS'))
  check('bootstrap names the protocol-mismatch wall after an app update', tpl.includes('protocol version mismatch'))
  check('every tmux invocation goes through $TMUX_BIN (no bare tmux calls left)',
    !/^\s*tmux /m.test(tpl) && !/\| tmux /.test(tpl))

  // Rendered form must be valid bash.
  const rendered = tpl.replaceAll('{AGENT_DIR}', '/tmp/fake-agent-dir').replaceAll('{MEMORY_DIR}', '/tmp/fake-mem')
  const tmp = path.join(os.tmpdir(), `attach-bs-render-${process.pid}.sh`)
  fs.writeFileSync(tmp, rendered)
  // bash -n needs bash. The bootstrap script is the mac attach lane's own
  // artifact, so on Windows there is neither a bash to check it with nor a
  // lane that would run it.
  if (process.platform === 'win32') {
    fs.rmSync(tmp, { force: true })
    console.log('  n/a  bash -n on the rendered bootstrap -- no bash, and no attach lane on Windows')
  } else {
    const bashCheck = spawnSync('/bin/bash', ['-n', tmp])
    fs.rmSync(tmp, { force: true })
    check('rendered bootstrap parses (bash -n)', bashCheck.status === 0)
  }

  // renderHarnessFiles moved to onboarding/harness-render.cjs (issue #9
  // PR-3) -- same assertions, new home.
  const renderSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  check('harness render includes attach-bootstrap.sh', renderSrc.includes("'attach-bootstrap.sh')"))
  // The 0o700 used to be a chmodSync line naming the file; renderHarnessFiles
  // became all-or-nothing (nogabi #6) so the mode now rides along with the
  // staged write. Source-text shape moved, behaviour did not -- and the real
  // resulting mode is asserted on disk by scripts/test-harness-refresh.mjs,
  // which is the check that should have been here in the first place.
  check('harness render includes sudo-askpass.sh + mode 0700',
    /'sudo-askpass\.sh'\)?,\s*'sudo-askpass\.sh',\s*0o700/.test(renderSrc) || /sudo-askpass\.sh'\),\s*'sudo-askpass\.sh',\s*0o700/.test(renderSrc))
  // Route BODIES moved to onboarding/routes/permissions.cjs (issue #9 PR-2).
  // Same assertions, new home.
  const permSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'permissions.cjs'), 'utf8')
  check('/api/topology route exists', permSrc.includes("pathname === '/api/topology'"))
  check('/api/sudo/password double gate: token AND settings toggle', permSrc.includes("req.headers['x-askpass-token'] !== askpassToken") && permSrc.includes("readAgentConfig().SUDO_ENABLED !== 'yes'"))
  check('sudo password stored via the verified vault path', permSrc.includes("storeProviderKeyVerified('sudo-pass'"))

  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  check('spawn path branches to attachStartFromSession on attach topology', /=== 'attach'\)\s*{\s*return attachStartFromSession\(config\)/.test(mainSrc))
  check('app quit leaves the external agent alive in attach mode', /agentTopologyIsAttach\(\)\)\s*{\s*log\('app quit: attach topology/.test(mainSrc))
  check('stop/restart use attach-aware death confirmation', (mainSrc.match(/agentTopologyIsAttach\(\) \? await waitForSupervisorDeath\(\) : await waitForAgentHandleCleared\(\)/g) || []).length === 2)
  check('spawn lane injects SUDO_ASKPASS', mainSrc.includes("supervisorEnv.SUDO_ASKPASS"))
  // Adopt-identity guard (design-0016 §Review card 1): session name alone
  // must not be adoption proof, and a null pane pid must never reach PIDFILE.
  check('attach adopt path gates on pane-pid validity', /const pidValid = Number\.isInteger\(panePid\)/.test(mainSrc))
  check('attach adopt path verifies supervisor identity before adopting', /identityOk = isOurSupervisor\(panePid\)/.test(mainSrc))
  {
    const guardIdx = mainSrc.indexOf('identityOk = isOurSupervisor(panePid)')
    const writeIdx = mainSrc.indexOf('attach: failed to write PIDFILE')
    check('attach identity guard sits before the PIDFILE write', guardIdx >= 0 && writeIdx >= 0 && guardIdx < writeIdx)
  }
}

// ── 4. sudo askpass helper: real end-to-end against a live HTTP endpoint ───
console.log('sudo askpass helper e2e:')
{
  const http = await import('node:http')
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-askpass-'))
  const SECRET = 'correct-horse-battery-staple'
  const TOKEN = 'a'.repeat(64)
  const server = http.createServer((req, res) => {
    if (req.url === '/api/sudo/password' && req.headers['x-askpass-token'] === TOKEN) {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(SECRET)
    } else {
      res.writeHead(403)
      res.end('forbidden')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const tpl = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'sudo-askpass.sh'), 'utf8')
  const helper = path.join(mem, 'sudo-askpass.sh')
  fs.writeFileSync(helper, tpl.replaceAll('{MEMORY_DIR}', mem))
  fs.chmodSync(helper, 0o700)

  // ASYNC spawn on purpose: the helper curls the http server living in THIS
  // process -- a spawnSync here blocks the event loop and deadlocks the test
  // against its own server (caught live on first run: curl waited forever).
  const { spawn } = await import('node:child_process')
  const runHelper = () => new Promise((resolve) => {
    const child = spawn('/bin/bash', [helper])
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })

  // no endpoint file -> loud failure
  let r = await runHelper()
  check('helper fails loud without the endpoint file', r.status !== 0 && r.stderr.includes('app is not running'))

  // real endpoint file -> prints the password (the sudo -A contract)
  fs.writeFileSync(path.join(mem, '.sudo-askpass-endpoint.json'), JSON.stringify({ port, token: TOKEN }) + '\n', { mode: 0o600 })
  r = await runHelper()
  check('helper prints the password on stdout', r.status === 0 && r.stdout === SECRET, `status=${r.status} stdout=${JSON.stringify(r.stdout)}`)
  check('helper leaks nothing to stderr on success', r.stderr === '')

  // wrong token -> curl -f fails, nothing printed
  fs.writeFileSync(path.join(mem, '.sudo-askpass-endpoint.json'), JSON.stringify({ port, token: 'b'.repeat(64) }) + '\n')
  r = await runHelper()
  check('helper fails closed on a wrong token', r.status !== 0 && r.stdout === '')

  server.close()
  fs.rmSync(mem, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
