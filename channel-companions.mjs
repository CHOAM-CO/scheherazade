// channel-companions.mjs -- one supervised child process per COMPANION messenger (0.3.7).
//
// Primary channel = the claude CLI's own agent-channel MCP server (restarted by
// supervisor.mjs with the lane). Every other enabled messenger is a companion:
// its channel script run with SCHEHERAZADE_CHANNEL_ROLE=companion, given ONLY
// its own credentials (built by main.cjs from resolveChannelCredentials), and
// restarted here on its own backoff ladder -- a Slack crash loop never bounces
// Discord or the agent. Companions live and die with the supervisor tree: main
// stops them whenever it stops the supervisor, and each holds a stdin pipe from
// main so a dead parent still ends them (installParentDeathExit in the scripts).
//
// spawn / timers / clock / fs are injected so tests drive the whole ladder with
// fakes (tests/test-channel-companions.mjs).

import fs from 'node:fs'
import path from 'node:path'

const HEALTHY_UPTIME_MS = 60_000 // a run this long resets the ladder (supervisor.mjs uptime policy)
const LIVE_FRESH_MS = 150_000    // same freshness the agent status poller uses

export function createCompanionManager({
  spawn, dataHome, backoffFor, log = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(),
  readFile = (f) => fs.readFileSync(f, 'utf8'),
}) {
  const entries = new Map() // backend -> state
  let stopped = true

  function launch(e) {
    if (stopped || e.disposed) return
    e.spawnedAt = now()
    e.state = 'running'
    let child
    try {
      child = spawn(e.spec)
    } catch (err) {
      log(`[companion:${e.spec.backend}] spawn failed: ${err.message}`)
      return afterExit(e, null, null, err.message)
    }
    e.child = child
    e.pid = child.pid || null
    if (child.stdout) child.stdout.on('data', (d) => log(`[companion:${e.spec.backend}] ${String(d).trim()}`))
    if (child.stderr) child.stderr.on('data', (d) => log(`[companion:${e.spec.backend}!] ${String(d).trim()}`))
    child.on('error', (err) => { log(`[companion:${e.spec.backend}] child error: ${err.message}`) })
    child.on('exit', (code, signal) => { if (e.child === child) afterExit(e, code, signal) })
  }

  function afterExit(e, code, signal, note) {
    e.child = null
    e.pid = null
    e.lastExit = { code, signal, at: now(), ...(note ? { note } : {}) }
    if (stopped || e.disposed) { e.state = 'stopped'; return }
    e.restarts = (now() - e.spawnedAt >= HEALTHY_UPTIME_MS) ? 1 : e.restarts + 1
    const secs = backoffFor(e.restarts)
    e.state = 'backoff'
    e.nextRetryAt = now() + secs * 1000
    log(`[companion:${e.spec.backend}] exited (code ${code}${signal ? `, signal ${signal}` : ''}), restart #${e.restarts} in ${secs}s`)
    e.timer = setTimer(() => { e.timer = null; launch(e) }, secs * 1000)
    if (e.timer && typeof e.timer.unref === 'function') e.timer.unref()
  }

  function readMarker(backend, file) {
    try { return JSON.parse(readFile(path.join(dataHome, file))) } catch { return null }
  }

  return {
    // specs: [{ backend, cmd, args, cwd, env }] -- env already carries only this messenger's secrets.
    start(specs) {
      stopped = false
      for (const spec of specs) {
        if (entries.has(spec.backend)) continue
        // stale markers from a previous run must not read as this run's state
        for (const f of [`.agent-live.${spec.backend}`, `.agent-failed.${spec.backend}.json`]) { try { fs.unlinkSync(path.join(dataHome, f)) } catch {} }
        const e = { spec, state: 'stopped', child: null, pid: null, restarts: 0, spawnedAt: 0, lastExit: null, timer: null, disposed: false }
        entries.set(spec.backend, e)
        launch(e)
      }
    },
    // Ends every companion and forgets them. `kill(child)` is injected by main (killTree).
    stopAll(kill = (c) => c.kill('SIGTERM')) {
      stopped = true
      for (const e of entries.values()) {
        e.disposed = true
        if (e.timer) { clearTimer(e.timer); e.timer = null }
        const c = e.child
        e.child = null
        e.state = 'stopped'
        if (c) { try { c.stdin && c.stdin.end() } catch {} try { kill(c) } catch (err) { log(`[companion:${e.spec.backend}] kill failed: ${err.message}`) } }
      }
      entries.clear()
    },
    // -> { [backend]: { state, pid, restarts, connected, failure?, nextRetryAt?, lastExit? } }
    status() {
      const out = {}
      for (const [backend, e] of entries) {
        const live = readMarker(backend, `.agent-live.${backend}`)
        const fail = readMarker(backend, `.agent-failed.${backend}.json`)
        const fresh = live && now() - Date.parse(live.lastHeartbeat) <= LIVE_FRESH_MS
        out[backend] = {
          state: e.state, pid: e.pid, restarts: e.restarts,
          connected: Boolean(fresh && e.state === 'running'),
          ...(fail && e.state !== 'running' ? { failure: { code: fail.code, reason: fail.reason } } : {}),
          ...(e.state === 'backoff' ? { nextRetryAt: e.nextRetryAt } : {}),
          ...(e.lastExit ? { lastExit: e.lastExit } : {}),
        }
      }
      return out
    },
  }
}
