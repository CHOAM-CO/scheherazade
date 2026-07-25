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
//                            ONTOLOGY_GUIDE.md / system_prompt.md (nogabi #6).
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
let status = { state: 'idle', code: null, detail: null, since: new Date().toISOString() }

function setAgentStatus(state, code = null, detail = null) {
  status = { state, code, detail, since: new Date().toISOString() }
}

function getAgentStatus() {
  return status
}

module.exports = { setAgentStatus, getAgentStatus }
