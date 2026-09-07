// attach-topology.cjs -- tmux IPC helpers for the attach lane (0.1.0 prep).
//
// TOPOLOGY (docs/design-0016-attach-topology.md, O2): the agent supervisor
// (`run.sh __loop`) lives in a pane of a tmux server the USER bootstrapped
// from their own terminal (onboarding/templates/attach-bootstrap.sh, rendered
// into DATA_HOME). TCC attributes permissions to the tmux server's terminal
// ancestry, so grants survive the app's per-release ad-hoc signature churn --
// the whole point.
//
// THE ONE INVARIANT THIS MODULE ENFORCES: the app must NEVER cause a tmux
// SERVER to exist. A server born from the app would silently re-key TCC
// attribution back to the per-release app identity -- worse than a loud
// failure, because everything works until the next release breaks every
// grant again. Therefore:
//   - every command here goes through tmuxIpc(), whose allowlist contains
//     ONLY verbs that error out when no server is running (live-verified
//     2026-07-16: `has-session`/`list-panes` on a dead socket exit 1 and
//     leave no server/socket behind; see tests/test-attach-topology.mjs).
//   - `new-session` is BANNED app-side even though it would usually attach
//     to the live server: in the server-just-died race it would START one,
//     app-descended. Restart uses `respawn-pane` (cannot create a server,
//     cannot even create a pane -- it only revives a dead one, and the
//     bootstrap set `remain-on-exit on` so dead panes persist to be revived).
//   - server lifetime is decoupled from the agent's: bootstrap sets
//     `exit-empty off` (default tmux kills the server with its last session
//     -- live-verified same day; that default would have stranded this
//     restart lane entirely).
//
// No Electron imports -- plain node, usable from tests.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ATTACH_SOCKET = 'scheherazade'
const ATTACH_SESSION = 'agent'

// Same DATA_HOME convention as the hooks (stop-reply-guard.mjs): honor the
// managed-spawn env first, fall back to the literal install path.
const DATA_HOME = process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', 'Scheherazade')

// Verbs that cannot create a tmux server (all error with "no server running"
// on a dead socket). Anything not listed here throws before reaching tmux.
// Trimmed to call-site-verified set (design-0016 card 3).
const SAFE_VERBS = new Set([
  'has-session',
  'list-panes',
  'display-message',
  'respawn-pane',
  'pipe-pane',
])

// The app-shipped portable tmux FIRST (v0.0.35, synced into DATA_HOME/bin by
// harness-render at boot): it is the binary attach-bootstrap.sh uses, so
// preferring it keeps the app's IPC client and the user's server the same
// build (no protocol skew within one install). Fixed brew locations follow
// as dev/legacy fallback -- a packaged Electron app's PATH is the launchd
// default (/usr/bin:/bin:...) and does NOT include Homebrew, so PATH-only
// resolution would "lose" tmux exactly in production (same class as
// http-server.cjs's resolveBin comment).
const TMUX_CANDIDATES = [
  path.join(DATA_HOME, 'bin', 'tmux-portable', 'tmux'),
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
]

function resolveTmuxBin() {
  for (const p of TMUX_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  // Dev fallback: PATH lookup via `command -v` semantics without a shell.
  // path.delimiter, not ':' -- Windows separates PATH entries with ';' and its
  // entries contain ':' themselves, so splitting on ':' yields garbage lookups
  // rather than a clean miss.
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, 'tmux')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

// Synchronous on purpose: every verb here is a local socket round-trip
// (single-digit ms), callers are lifecycle paths that are already async at
// their own layer, and sync keeps the no-interleaving property the spawn
// lane's serialized lifecycle comments rely on.
function tmuxIpc(args, { timeoutMs = 4000 } = {}) {
  const verb = args[0]
  if (!SAFE_VERBS.has(verb)) {
    throw new Error(`tmuxIpc: verb '${verb}' is not in the no-server-spawn allowlist -- see attach-topology.cjs header`)
  }
  const bin = resolveTmuxBin()
  if (!bin) return { ok: false, code: null, stdout: '', stderr: 'tmux not found' }
  try {
    const stdout = execFileSync(bin, ['-L', ATTACH_SOCKET, ...args], {
      timeout: timeoutMs,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, code: 0, stdout, stderr: '' }
  } catch (err) {
    return {
      ok: false,
      code: typeof err.status === 'number' ? err.status : null,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message || ''),
    }
  }
}

// One snapshot of the attach world, never throwing, never server-spawning.
function attachSessionState() {
  const tmuxBin = resolveTmuxBin()
  if (!tmuxBin) return { tmuxPresent: false, sessionPresent: false, paneDead: false, panePid: null }
  const has = tmuxIpc(['has-session', '-t', ATTACH_SESSION])
  if (!has.ok) return { tmuxPresent: true, sessionPresent: false, paneDead: false, panePid: null }
  const panes = tmuxIpc(['list-panes', '-t', ATTACH_SESSION, '-F', '#{pane_dead} #{pane_pid}'])
  if (!panes.ok) return { tmuxPresent: true, sessionPresent: true, paneDead: false, panePid: null }
  const first = panes.stdout.trim().split('\n')[0] || ''
  const [dead, pid] = first.split(' ')
  return {
    tmuxPresent: true,
    sessionPresent: true,
    paneDead: dead === '1',
    panePid: Number.parseInt(pid, 10) || null,
  }
}

// Revive a dead agent pane: respawn (same original command = fresh
// `bash run.sh __loop`, which re-sources .agent-config -- so a model swap
// written to config before this call takes effect), re-apply pipe-pane (it
// does not reliably survive respawn), return the new pane pid.
function respawnAttachPane({ logFile }) {
  const respawn = tmuxIpc(['respawn-pane', '-t', ATTACH_SESSION])
  if (!respawn.ok) return { ok: false, error: `respawn-pane failed: ${respawn.stderr.trim()}` }
  if (logFile) {
    const escaped = logFile.replace(/'/g, "'\\''")
    const pipe = tmuxIpc(['pipe-pane', '-o', '-t', ATTACH_SESSION, `cat >> '${escaped}'`])
    if (!pipe.ok) return { ok: false, error: `pipe-pane failed after respawn: ${pipe.stderr.trim()}` }
  }
  const disp = tmuxIpc(['display-message', '-p', '-t', ATTACH_SESSION, '#{pane_pid}'])
  const panePid = disp.ok ? Number.parseInt(disp.stdout.trim(), 10) : null
  if (!panePid) return { ok: false, error: 'respawned but could not read pane_pid' }
  return { ok: true, panePid }
}

// The exact line the UI tells the user to paste into their terminal.
function bootstrapCommand(dataHome) {
  return `bash "${path.join(dataHome, 'attach-bootstrap.sh')}"`
}

module.exports = {
  ATTACH_SOCKET,
  ATTACH_SESSION,
  SAFE_VERBS,
  resolveTmuxBin,
  tmuxIpc,
  attachSessionState,
  respawnAttachPane,
  bootstrapCommand,
}
