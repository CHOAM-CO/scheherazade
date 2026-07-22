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

  // Rendered form must be valid bash.
  const rendered = tpl.replaceAll('{AGENT_DIR}', '/tmp/fake-agent-dir').replaceAll('{MEMORY_DIR}', '/tmp/fake-mem')
  const tmp = path.join(os.tmpdir(), `attach-bs-render-${process.pid}.sh`)
  fs.writeFileSync(tmp, rendered)
  const bashCheck = spawnSync('/bin/bash', ['-n', tmp])
  fs.rmSync(tmp, { force: true })
  check('rendered bootstrap parses (bash -n)', bashCheck.status === 0)

  const httpSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  check('harness render includes attach-bootstrap.sh', httpSrc.includes("'attach-bootstrap.sh')"))
  check('harness render includes sudo-askpass.sh + chmod 700', httpSrc.includes("'sudo-askpass.sh')") && /chmodSync\(.*sudo-askpass\.sh.*0o700\)/.test(httpSrc))
  check('/api/topology route exists', httpSrc.includes("pathname === '/api/topology'"))
  check('/api/sudo/password double gate: token AND settings toggle', httpSrc.includes("req.headers['x-askpass-token'] !== askpassToken") && httpSrc.includes("readAgentConfig().SUDO_ENABLED !== 'yes'"))
  check('sudo password stored via the verified vault path', httpSrc.includes("storeProviderKeyVerified('sudo-pass'"))

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
