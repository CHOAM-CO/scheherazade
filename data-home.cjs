// data-home.cjs -- ONE resolver for the agent's data directory.
//
// design-0023 P3 deliverable 4. Before this file the same answer was computed
// in 13 places with THREE different formulas and TWO env names:
//   `AGENT_DATA_HOME || ~/Documents/Scheherazade`  (http-server, attach-topology, 7 hooks)
//   `AGENT_DATA_HOME || ~/Documents/<AGENT_NAME>`  (supervisor, channel-runtime, run.sh)
//   `MEM || cwd` / `AGENT_DATA_HOME || MEM || cwd` (session-start, checkpoint-nudge, context-gauge)
//   a hardcoded literal with no override at all     (memory/service.mjs, bootstrap.cjs)
// So a user who set AGENT_DATA_HOME moved everything EXCEPT memory.db and the
// managed-install dir -- the agent's memory silently stayed in the old home
// (read-D §6 #3).
//
// LOCKED (docs/HISTORY.md §DATA_HOME, decisions.log 114): the default is the
// fixed product name `~/Documents/Scheherazade`, NOT keyed on AGENT_NAME or
// DISPLAY_NAME -- a rename in Settings edits DISPLAY_NAME only and must never
// move the database. Callers that legitimately follow a per-agent name (the
// supervisor and channel-runtime, for CLI deployments where AGENT_NAME is the
// deployment's own identity) pass it explicitly.
//
// Precedence, one order: AGENT_DATA_HOME (what main.cjs exports to every
// child) -> MEM (the LANE->HOOK spelling; the supervisor exports it and the
// Claude CLI passes it down) -> ~/Documents/<name>. AGENT_DATA_HOME is the ONE
// spelling this codebase WRITES; MEM is only ever read.
//
// `allowMem` exists because MEM is a dangerously generic name. Inside the
// app's own process (Electron main, the onboarding server, the managed-install
// bootstrap, the supervisor's own config) MEM has never been an input, and a
// stray MEM in the shell that launched the app would silently relocate the
// agent's whole home -- including memory.db. Those call sites pass
// allowMem:false; the hooks, which are spawned by the CLI with MEM set and are
// the reason the spelling exists at all, keep the default.
//
// Plain CJS, no Electron: required from main/onboarding/attach-topology and
// imported from ESM (supervisor, hooks, memory, channel-runtime).

const os = require('node:os')
const path = require('node:path')

// The product's fixed on-disk name. Change this and you have moved every
// user's memory -- see the lock above.
const DEFAULT_AGENT_NAME = 'Scheherazade'

function resolveDataHome({ env = process.env, agentName = null, home = null, allowMem = true } = {}) {
  const explicit = env.AGENT_DATA_HOME || (allowMem ? env.MEM : null)
  if (explicit && String(explicit).trim()) return String(explicit).trim()
  const name = (agentName && String(agentName).trim()) || DEFAULT_AGENT_NAME
  return path.join(home || os.homedir(), 'Documents', name)
}

// The memory DB lives IN the data home. SCHEHERAZADE_MEMORY_DB is the explicit
// override (tests/smoke.mjs points it at a disposable file); it stays, because
// it is deliberate and per-process, unlike the accidental split this module
// closes.
function resolveMemoryDb({ env = process.env, dataHome = null, agentName = null, home = null, allowMem = false } = {}) {
  if (env.SCHEHERAZADE_MEMORY_DB) return env.SCHEHERAZADE_MEMORY_DB
  return path.join(dataHome || resolveDataHome({ env, agentName, home, allowMem }), 'memory.db')
}

module.exports = { DEFAULT_AGENT_NAME, resolveDataHome, resolveMemoryDb }
