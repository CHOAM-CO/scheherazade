'use strict'
// ── ollama daemon supervision (ollama provider, 2026-07-07) ──────────────
// The ollama provider mode routes the agent at OLLAMA_BASE_URL
// (provider-env.cjs, localhost:11434), assuming an `ollama serve` daemon is
// listening. Our bootstrap installs Ollama.app WITHOUT ever launching its
// GUI (the GUI's symlink step is the only admin prompt, and launching it
// would also enroll its login item) -- which means on a fresh Mac NOTHING
// starts the daemon. Without this module, onboarding completes into a dead
// agent and the only manual fix is a Terminal command -- forbidden by the
// product constitution ("유저가 절대 CLI창 만지게 하지 않는다"). So the app
// supervises the daemon itself, mirroring main.cjs's ensureCodexProxy:
//
//   - REUSE-WITH-IDENTITY, not bind-first: unlike codex-as-api (an
//     in-process library, where the kernel arbitrates ownership atomically
//     via EADDRINUSE), the ollama daemon is an EXTERNAL child process, so
//     the bind-first trick is unavailable. An already-listening daemon is
//     the ecosystem-correct thing to reuse (ollama's own design: one local
//     daemon, every client shares it) -- but ONLY after verifying the
//     listener's identity, because routing the agent at an unrecognized
//     local service would hand it the whole conversation stream (same
//     threat as the proxy's round-2 finding). Identity = the listening
//     pid's executable is codesign-verified against the pinned Ollama Team
//     ID (bootstrap.cjs's verifySignedByPinnedTeam -- an HTTP response is
//     NOT identity). Known residual: pid-based identity has an inherent
//     TOCTOU window (listener could die and the port re-bind between check
//     and use) that bind-first would have closed; it is documented rather
//     than solved because no stronger primitive exists for an external
//     daemon we must not own. A reused daemon is NEVER ours to signal.
//   - FAIL-CLOSED: identity mismatch on an occupied port blocks the agent
//     spawn, loudly. No port opt-in escape hatch in v1.1 (unlike
//     CHATGPT_PROXY_PORT): ollama's port is pinned by OLLAMA_BASE_URL and
//     changing it requires agreeing env on both daemon and agent -- a
//     config surface nobody asked for yet.
//   - MANAGED SPAWN: when nothing listens, spawn `<resolveBin('ollama')>
//     serve` ourselves -- fixed-path resolution only (no PATH walk) +
//     verifyManagedBin recheck (TOFU manifest) before every spawn, same
//     rules as the login shell-out. OLLAMA_HOST pinned to loopback.
//   - NO AUTO-RESTART in v1.1: if our daemon child dies later, the agent's
//     calls fail visibly and the next spawnRealAgentChild() pass re-runs
//     this. Loud log, no silent loop. (Same rule as ensureCodexProxy.)
//   - Reentrancy: only called inside spawnRealAgentChildLocked(), which is
//     already serialized by main.cjs's agentSpawning sentinel.
//
// Known gap, deliberately out of scope tonight (recorded, not hidden): a
// running daemon does not guarantee the CONFIGURED MODEL is available
// (local tags need `ollama pull`; :cloud tags need the signin this app
// already does). Model-availability UX is a separate onboarding item.

const { spawn } = require('node:child_process')

const { resolveBin } = require('./http-server.cjs')
const { verifyManagedBin, verifySignedByPinnedTeam } = require('./bootstrap.cjs')
const { OLLAMA_BASE_URL } = require('../provider-env.cjs')

// Single source of truth: the port the agent will actually dial
// (provider-env.cjs), not a second hardcoded copy that can drift.
const OLLAMA_PORT = Number(new URL(OLLAMA_BASE_URL).port) || 11434

const SPAWN_READY_TIMEOUT_MS = 10_000
const SPAWN_READY_POLL_MS = 250

let ollamaDaemonChild = null

function log(msg) {
  console.log(`[scheherazade/ollama-daemon] ${msg}`)
}

async function alive(port) {
  try {
    // Any HTTP response = something listens (same contract as
    // ensureCodexProxy's alive() / http-server's checkLocalLiveness).
    // Liveness only -- identity is codesign's job, never the response's.
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(750) })
    return true
  } catch {
    return false
  }
}

// Port owner + executable path: proc.cjs (one platform seam). The old copies
// here were mac-only -- `/usr/sbin/lsof` does not exist on Linux (empty
// listener list -> owner "unknown" -> fail-closed refusal), and procps
// `ps -o comm=` reports the SHORT name, not the path the codesign check
// needs. proc.listenerPids falls back to `ss -ltnp` and proc.execPathOfPid
// reads /proc/<pid>/exe there.
const { listenerPids, execPathOfPid, killTree } = require('../proc.cjs')

// Every listening pid on the port must be a codesign-verified Ollama
// binary. Plural pids on one LISTEN port is abnormal; requiring ALL to
// pass keeps the weird case fail-closed instead of first-match lucky.
async function listenerIsOllama(port) {
  const pids = listenerPids(port)
  if (!pids.length) return { ok: false, why: 'listener pid could not be determined (port-owner lookup empty/failed)' }
  for (const pid of pids) {
    const exe = execPathOfPid(pid)
    if (!exe) return { ok: false, why: `pid ${pid}: executable path could not be read` }
    // verifySignedByPinnedTeam is `codesign` -- macOS only. On Windows the
    // whole identity lane used to come back empty and the CALLER is
    // fail-closed, so picking the ollama provider on Windows blocked the
    // daemon, which made ensureOllamaDaemon() return false, which parked the
    // agent at 'failed' WITHOUT EVER SPAWNING IT -- while telling the user
    // their own Ollama was an unrecognized service. Detection-only on Windows
    // for v1 (the locked scoping call): match the executable by path and say
    // out loud that this is weaker than the mac check.
    if (process.platform === 'win32') {
      if (!/[\\/]ollama(\.exe)?$/i.test(exe)) {
        return { ok: false, why: `pid ${pid} (${exe}): does not look like ollama.exe` }
      }
      log(`win32: :${port} owner pid ${pid} accepted by PATH MATCH only (${exe}) -- no signature check on this platform`)
      continue
    }
    try {
      await verifySignedByPinnedTeam(exe, 'ollama')
    } catch (err) {
      return { ok: false, why: `pid ${pid} (${exe}): ${err.message}` }
    }
  }
  return { ok: true, pids }
}

// port param exists ONLY for the plain-node test harness (spawn/fail-closed
// paths can't run against the real 11434 on a machine that already has a
// daemon). Production callers pass nothing: the agent always dials
// OLLAMA_BASE_URL, so supervising any other port would be a lie.
async function ensureOllamaDaemon({ port = OLLAMA_PORT } = {}) {
  // Reap a dead handle first so a crashed child doesn't wedge this into
  // the "already ours" branch forever (stale-handle lesson, proxy round 3).
  if (ollamaDaemonChild && ollamaDaemonChild.exitCode === null && !ollamaDaemonChild.killed) {
    // Same ownership bar as the ready-poll below (Codex round-8): an HTTP
    // answer alone doesn't prove OUR child still owns the port.
    const ownPid = ollamaDaemonChild.pid
    const pids = listenerPids(port)
    if ((await alive(port)) && pids.length && pids.every((p) => Number(p) === ownPid)) {
      log(`our daemon child (pid=${ownPid}) already serves :${port} (listener ownership verified)`)
      return true
    }
    log(`our daemon child (pid=${ownPid}) is alive but does not verifiably own :${port} (listener pid(s): ${pids.join(',') || 'none'}) -- killing and re-evaluating`)
    killOllamaDaemon('SIGTERM')
    // Fall through: if a FOREIGN listener holds the port, the occupied-port
    // identity path below decides (codesign or BLOCK) -- never this branch.
  } else if (ollamaDaemonChild) {
    log(`reaping dead daemon child handle (exitCode=${ollamaDaemonChild.exitCode})`)
    ollamaDaemonChild = null
  }

  if (await alive(port)) {
    const identity = await listenerIsOllama(port)
    if (identity.ok) {
      log(`reusing existing ollama daemon on :${port} (pid(s) ${identity.pids.join(',')}, codesign-verified; not ours, never signaled)`)
      return true
    }
    console.error(
      `[scheherazade/ollama-daemon] BLOCKED -- :${port} is occupied by a listener that does not codesign-verify as Ollama ` +
        `(${identity.why}). Routing the agent at it would hand an unrecognized local service the whole conversation ` +
        'stream. Quit that process and relaunch.'
    )
    return false
  }

  const bin = resolveBin('ollama')
  if (!bin) {
    console.error('[scheherazade/ollama-daemon] ollama binary not found at any fixed location -- bootstrap step missing?')
    return false
  }
  // verifyManagedBin returns FALSE on tamper/unrecorded -- it does not
  // throw (Codex round-7 finding #2: a try/catch here was a no-op guard
  // that would have spawned a tampered managed binary).
  if (!verifyManagedBin(bin)) {
    console.error(`[scheherazade/ollama-daemon] managed-binary verification refused ${bin} -- not spawning it (see bootstrap log)`)
    return false
  }

  log(`spawning managed daemon: ${bin} serve (OLLAMA_HOST=127.0.0.1:${port})`)
  // detached: own process group, so killOllamaDaemon can group-SIGTERM and
  // reap grandchildren too (ollama forks model-runner subprocesses once a
  // model loads; T4's fake-binary test showed a lone child.kill orphans
  // them). Same pattern as the login children (Codex finding #3). NOT
  // unref()'d -- the app still supervises it and kills it on quit/fatal.
  const child = spawn(bin, ['serve'], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  ollamaDaemonChild = child
  child.stdout.on('data', (d) => log(`daemon stdout: ${String(d).trimEnd()}`))
  child.stderr.on('data', (d) => log(`daemon stderr: ${String(d).trimEnd()}`))
  child.on('exit', (code, signal) => {
    // Loud only -- NO AUTO-RESTART (header). The handle is reaped on the
    // next ensureOllamaDaemon() pass, not here, to keep exit handling
    // side-effect-free (same shape as the login children's bookkeeping).
    log(`daemon child pid=${child.pid} exited (code=${code}, signal=${signal})`)
  })

  const deadline = Date.now() + SPAWN_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      console.error(`[scheherazade/ollama-daemon] daemon exited during startup (code=${child.exitCode}) -- see its stderr above`)
      ollamaDaemonChild = null
      return false
    }
    if (await alive(port)) {
      // Codex round-7 finding #1: an HTTP answer here is NOT proof our
      // child owns the port. A hostile process can win the bind in the
      // window between the pre-spawn alive() check and ollama's own bind;
      // our child then dies on EADDRINUSE a beat later while the attacker
      // answers this poll. So the listener must BE our child pid --
      // kernel-reported ownership, same trust class as the proxy's
      // bind-first. (ollama 0.30.x listens in-process, no fork; if that
      // ever changes this fails LOUD, never open.)
      const pids = listenerPids(port)
      if (pids.length && pids.every((p) => Number(p) === child.pid)) {
        log(`managed daemon up on :${port} (pid=${child.pid}, listener ownership verified)`)
        return true
      }
      if (pids.length) {
        console.error(
          `[scheherazade/ollama-daemon] BLOCKED -- :${port} answered during our spawn but is owned by pid(s) ${pids.join(',')}, ` +
            `not our child (pid=${child.pid}). Killing our child and refusing to route the agent.`
        )
        killOllamaDaemon('SIGTERM')
        return false
      }
      // lsof came back empty (transient/glitch): neither confirm nor
      // condemn -- keep polling until the deadline, fail-closed there.
    }
    await new Promise((r) => setTimeout(r, SPAWN_READY_POLL_MS))
  }
  console.error(`[scheherazade/ollama-daemon] daemon did not answer on :${port} within ${SPAWN_READY_TIMEOUT_MS}ms -- killing it`)
  killOllamaDaemon('SIGTERM')
  return false
}

function killOllamaDaemon(signal = 'SIGTERM') {
  if (!ollamaDaemonChild) return // a reused external daemon is never ours to touch
  const pid = ollamaDaemonChild.pid
  try {
    // Group kill (detached spawn above): negative pid signals the whole
    // process group, reaping model-runner grandchildren with the daemon.
    // Windows has no process groups to signal, so taskkill /T is the
    // equivalent -- without it this always threw and the fallback below
    // reached only the daemon, leaving model-runner grandchildren alive.
    killTree(pid, signal)
    log(`killOllamaDaemon: sent ${signal} to process tree ${pid}`)
  } catch (err) {
    // Group already gone, or platform quirk -- fall back to the lone child.
    try {
      ollamaDaemonChild.kill(signal)
      log(`killOllamaDaemon: group kill failed (${err.message}); sent ${signal} to pid=${pid}`)
    } catch (err2) {
      log(`killOllamaDaemon: kill failed (${err2.message}) -- proceeding`)
    }
  }
  ollamaDaemonChild = null
}

module.exports = {
  ensureOllamaDaemon,
  killOllamaDaemon,
  OLLAMA_PORT,
}
