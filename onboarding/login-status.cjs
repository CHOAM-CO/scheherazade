'use strict'
// onboarding/login-status.cjs — shared in-memory per-provider LOGIN-FLOW
// status (login shell-out feature, 2026-07-07).
//
// Same singleton pattern as agent-status.cjs (see its header for the full
// rationale): written by http-server.cjs's POST/DELETE
// /api/onboarding/login/:provider handlers around the spawned `codex login`
// / `ollama signin` child, read by the GET .../status polling route. Both
// run in the same Electron main process and require() this exact module
// path, so Node's module cache shares the object -- no IPC.
//
// Deliberately SEPARATE from agent-status.cjs rather than folded into it:
// that module tracks the long-lived supervisor's process liveness;
// this one tracks short-lived, user-initiated login children, per provider,
// with a different state vocabulary. Merging them would overload
// agent-status's `state` enum that computeAgentStatus() and the Step 5
// wizard already depend on.
//
// States:
//   idle    -- no login attempted this app-session.
//   running -- a login child is currently alive (browser OAuth in flight).
//   success -- login confirmed: either the fast-path probe said "already
//              logged in" / the identity artifact already existed, or the
//              spawned child exited 0 AND the expected artifact exists.
//   failed  -- see `code`.
//
// Cause `code` (stable machine-readable, only meaningful when failed):
//   'cli_missing'   -- binary not found on PATH (honest Path-A copy: the
//                      friction is moved into an install pointer, not hidden)
//   'cancelled'     -- user hit DELETE (cancel) while running
//   'timeout'       -- exceeded LOGIN_TIMEOUT_MS (http-server.cjs), child
//                      process-group SIGTERMed
//   'exit_nonzero'  -- child exited non-zero. `detail` stays COARSE; the
//                      exit code + stderr tail go to the server-side log
//                      ONLY (Codex finding #5 -- stderr can carry OAuth
//                      URLs/device codes, and GET status needs no token)
//   'unknown'       -- exit 0 but expected artifact absent, or any other
//                      unenumerated path (never guess a more specific code)
// `detail` is free-form prose for logs/UI, mirroring agent-status.cjs.

// 'ollama' removed 2026-08-04 (the owner: "ollama -> API키") -- ollama's connect
// method is now an ollama.com API-key paste (see provider-env.cjs's ollama
// row), so it has no login shell-out flow anymore. Only chatgpt remains a
// login-flow provider (`codex login`).
const LOGIN_PROVIDERS = ['chatgpt']

const statuses = {}
for (const p of LOGIN_PROVIDERS) {
  statuses[p] = { state: 'idle', code: null, detail: null, since: new Date().toISOString() }
}

function setLoginStatus(provider, state, code = null, detail = null) {
  statuses[provider] = { state, code, detail, since: new Date().toISOString() }
}

function getLoginStatus(provider) {
  return statuses[provider]
}

module.exports = { LOGIN_PROVIDERS, setLoginStatus, getLoginStatus }
