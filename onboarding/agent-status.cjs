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
//                 discord.js gateway connect all take real time).
//   failed     -- the persistent supervisor process itself (bash run.sh
//                 __loop) failed to spawn or exited unexpectedly. NOT set
//                 for an individual `claude` crash inside the loop -- those
//                 are absorbed by run.sh's own restart/backoff ladder and
//                 never surface here. `reason` carries the cause for
//                 fail-loud surfacing to the user.
let status = { state: 'idle', reason: null, since: new Date().toISOString() }

function setAgentStatus(state, reason = null) {
  status = { state, reason, since: new Date().toISOString() }
}

function getAgentStatus() {
  return status
}

module.exports = { setAgentStatus, getAgentStatus }
