'use strict'
// onboarding/agent-status.cjs — shared in-memory agent-liveness status.
//
// Written by main.cjs's real-agent child process lifecycle (spawn attempt /
// error / unexpected exit) and read by http-server.cjs's GET
// /api/agent/status polling route (Part 4 of the agent-lifecycle fix,
// 2026-07-03: Step 5's success screen must gate on real liveness, not the
// ONBOARDING_COMPLETE flip). Both files run inside the SAME Electron main
// process and both `require()` this exact module path, so Node's module
// cache gives them the same singleton object -- no IPC, no polling of each
// other, just a plain shared reference.
//
// This module tracks only the PROCESS side of liveness (did the persistent
// run.sh __loop supervisor spawn, is it still alive). It deliberately does
// NOT know about Discord-level liveness (the ClientReady heartbeat marker
// channel.mjs writes to DATA_HOME/.agent-live) -- that half is read
// directly off disk by http-server.cjs's GET /api/agent/status handler and
// combined with this module's state there. Keeping the two halves separate
// avoids this module depending on DATA_HOME/fs at all.
//
// States:
//   idle       -- no spawn attempted yet.
//   connecting -- child process spawned successfully; Discord-level
//                 liveness not confirmed yet. Normal for the first several
//                 seconds after spawn (claude boot + MCP handshake +
//                 discord.js gateway connect all take real time). `since`
//                 is re-stamped every time this state is (re-)entered --
//                 spawnRealAgentChild() in main.cjs calls
//                 setAgentStatus('connecting') at the moment of each spawn
//                 ATTEMPT (not at onboarding-complete), so `since` always
//                 means "since this spawn attempt", resetting cleanly on
//                 every relaunch. http-server.cjs's computeAgentStatus()
//                 uses this exact field as its connecting-timeout backstop
//                 (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 2) --
//                 see that function's own comment for the precedence rule.
//   failed     -- either (a) the persistent supervisor process itself (bash
//                 run.sh __loop) failed to spawn or exited unexpectedly,
//                 (b) a pre-spawn blocker in main.cjs (missing CLI binary,
//                 unwired provider, credential read failure), or (c) a
//                 failure marker relayed from run.sh's crash-loop detector
//                 or channel.mjs's Discord-login guard (see main.cjs's
//                 pollFailureMarker()). NOT set for an individual `claude`
//                 crash inside the loop -- those are absorbed by run.sh's
//                 own restart/backoff ladder and never surface here.
//   stopped    -- control panel (2026-07-09): the user deliberately turned the
//                 agent OFF (main.cjs stopAgent()). Distinct from 'failed' (a
//                 crash) and from 'idle' (never spawned). computeAgentStatus()
//                 in http-server.cjs gives this HIGHEST precedence so a still-
//                 fresh .agent-live marker can't read a just-stopped agent back
//                 as 'live'. A control-panel start/restart moves it off this
//                 state ('connecting' on the next spawn attempt).
//
// Cause CODE (Step 5 onboarding-wiring fix, 2026-07-03, PIECE 1): `code` is
// a STABLE machine-readable value, only meaningful when state === 'failed'.
// One of:
//   'crash_loop'          -- run.sh's write_failure() (3+ quick-fail restarts)
//   'discord_token_bad'   -- channel.mjs's writeFailureMarker() on a missing
//                            or rejected Discord bot token
//   'provider_not_wired'  -- main.cjs spawnRealAgentChild()'s non-claude
//                            branch (chatgpt/ollama have no router yet)
//   'key_error'           -- main.cjs's readProviderKey() threw
//   'harness_stale'       -- main.cjs's pre-spawn gate: the boot harness
//                            re-render failed, so the agent was NOT started
//                            against an out-of-date CLAUDE.md /
//                            ONTOLOGY_GUIDE.md / system_prompt.md (harness-refresh #6).
//                            Clears itself on the next boot that renders
//   'timeout'             -- http-server.cjs's computeAgentStatus() backstop
//                            (connecting exceeded TIMEOUT_MS with no live
//                            marker) -- this module never sets it itself,
//                            it's computed downstream at read time
//   'unknown'             -- any other failure path (fallback; never guess a
//                            more specific code than the emitter actually
//                            knows)
// `detail` stays a free-form human-readable string for logs/UI (renamed
// from the old `reason` field -- same purpose, name changed because `code`
// is now the stable value and `detail` is explicitly the prose one).
//
// ── the list above is now DATA (2026-08-04) ─────────────────────────────
// It was prose for a month, and prose does not get checked. Three codes had
// drifted out of it and past the UI at the same time: 'bootstrap-needed'
// (four call sites in main.cjs), 'slack_token_bad' and 'telegram_token_bad'
// (written into the failure marker by their own channel modules and relayed
// here by pollFailureMarker). None had a row in copy.js, so all three
// rendered as the 'unknown' fallback -- "wait a moment and click Check
// status again" -- for three conditions where waiting fixes nothing and we
// knew exactly what was wrong.
//
// Codex's equivalent is a closed union the compiler enforces. We have no
// compiler, so the enforcement is: this list, plus a test
// (tests/test-agent-status-codes.mjs) that reads every code literal out of
// the source and every row out of copy.js and demands the three agree.
//
// Adding a code means: add it here, add a copy.js row, and the test passes.
// Skipping either half is the exact failure this const exists to stop.
const AGENT_STATES = Object.freeze(['idle', 'connecting', 'live', 'stopped', 'failed'])

// Grouped by WHOSE PROBLEM IT IS, because that is what decides the sentence
// the user reads. The nine codes below 'harness_stale' were all a single
// 'unknown' until 2026-08-04, at 13 call sites -- every one of which knew
// exactly what had happened and reported that it did not.
const AGENT_STATUS_CODES = Object.freeze([
  // -- the user's credentials
  'discord_token_bad', // token missing or rejected by the service
  'slack_token_bad',
  'telegram_token_bad',
  'channel_token_error', // token could not be READ -- the OS refused to unseal it
  'key_error', // same, for the provider key
  // -- the user's configuration
  'provider_not_wired',
  'cli_missing', // Claude Code is not installed on this machine
  'ollama_unavailable', // the local Ollama daemon is not up
  'proxy_unavailable', // the local codex-as-api proxy is not up
  'bootstrap-needed', // attach topology with nothing to attach to
  // -- our problem
  'app_files_missing', // a file we ship is absent from our own bundle
  'harness_stale', // the boot harness re-render failed
  'spawn_failed', // the supervisor process never started
  'attach_failed', // could not respawn a dead attach pane
  // -- it ran and then stopped
  'crash_loop', // run.sh's write_failure(): 3+ quick-fail restarts
  'agent_exited', // the supervisor started, then exited unexpectedly
  'stop_unconfirmed', // a stop/restart could not confirm the old process died
  // -- we genuinely do not know
  'timeout', // computed downstream in http-server.cjs, never set here
  'unknown', // last resort; never guess a specific code the emitter lacks
])

let status = { state: 'idle', code: null, detail: null, since: new Date().toISOString() }

function setAgentStatus(state, code = null, detail = null) {
  // Log-and-coerce, NOT throw. An unrecognized code is a bug in the caller,
  // but every caller here is on a failure path already -- throwing would turn
  // "the agent failed and we labelled it badly" into "the app crashed while
  // reporting that the agent failed". Coercing to 'unknown' lands the user on
  // the fallback copy row, which is where an unrecognized code would have sent
  // them anyway (wizard.js: `causes[code] || causes.unknown`); the console line
  // is what tells a developer the vocabulary needs a new entry.
  //
  // The static test is the real guard. This is the runtime backstop for a code
  // built by string concatenation, which the test cannot see.
  let safeCode = code
  if (code !== null && !AGENT_STATUS_CODES.includes(code)) {
    console.error(`[scheherazade/agent-status] unrecognized status code "${code}" (state=${state}) -- reported as "unknown". Add it to AGENT_STATUS_CODES and give it a copy.js row.`)
    safeCode = 'unknown'
  }
  status = { state, code: safeCode, detail, since: new Date().toISOString() }
}

function getAgentStatus() {
  return status
}

module.exports = { setAgentStatus, getAgentStatus, AGENT_STATES, AGENT_STATUS_CODES }
