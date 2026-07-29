// onboarding/routes/setup-token.cjs -- in-app `claude setup-token` capture
// (group 10). Thin: every handler here delegates to the session object and
// returns its status. No credential, no child output, and no caller-supplied
// value is ever interpolated into a response.
//
// That last clause is the one worth stating explicitly. The recurring defect
// class on this server has been unbounded echo -- a refusal string quoting
// whatever the caller sent, landing in a one-line status element. These
// handlers structurally cannot: the only strings they emit are fixed enum
// members produced by setup-token-session.cjs. If a future handler here needs
// to explain something with caller input in it, bound it at the source the
// way resolveCustomBaseUrl does, not with a .slice() at the send.
//
// Route bodies bind their dependencies ONCE from staticCtx, same contract as
// every other group in this directory (see provider.cjs's header).
'use strict'

function createRoutes(staticCtx) {
  const { sendJson, readJsonBody, getSetupTokenSession } = staticCtx
  return [
    // POST start: mutating -> per-launch token gate (handled by the caller's
    // X-Onboard-Token check, same as every other POST here). Fire-and-forget;
    // the client polls status. 202 on a started or already-running flow, 409
    // when the machine cannot start one at all (no CLI, spawn refused) --
    // distinguishable by the client without parsing prose.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/setup-token/start',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value, never staticCtx
        const session = getSetupTokenSession(agentControls)
        const result = session.start()
        // status() FIRST, then the call-specific fields. status() carries its
        // own `reason`, which is null whenever the session is not in a failed
        // state -- spread last, it silently overwrote the reason this call is
        // reporting. Caught on the wire by the dispatch e2e, not by the
        // session's own unit tests, which never see this object.
        if (!result.ok) {
          sendJson(res, 409, { ...session.status(), ok: false, reason: result.reason })
          return
        }
        sendJson(res, 202, { ...session.status(), ok: true })
        return
      },
    },
    // GET status: read-only poll, no token gate. Safe to expose because
    // status() carries fixed enum members and a clock reading only -- see
    // setup-token-session.cjs, where that guarantee is enforced and tested.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/setup-token/status',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx
        sendJson(res, 200, getSetupTokenSession(agentControls).status())
        return
      },
    },
    // POST code: the manual fallback. The CLI races a localhost /callback
    // listener against its own paste prompt, so on most machines this is
    // never called -- the redirect wins and the flow completes untouched.
    // It exists for the case where the browser cannot reach loopback.
    //
    // The code goes into a pty, which interprets control characters, so the
    // session shape-checks it before writing (a bare "\r" would submit early;
    // an escape sequence would drive the TUI). A rejected code is reported by
    // name and never echoed back.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/setup-token/code',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx
        const { code } = await readJsonBody(req)
        const session = getSetupTokenSession(agentControls)
        const result = session.submitCode(code)
        // status() first -- see the start handler's note on why the order is
        // load-bearing. `code` is never echoed: the only strings in this
        // response are session enum members.
        if (!result.ok) {
          sendJson(res, 400, { ...session.status(), ok: false, reason: result.reason })
          return
        }
        sendJson(res, 202, { ...session.status(), ok: true })
        return
      },
    },
    // POST cancel: user backed out. Kills the child so an abandoned flow does
    // not sit on a pty and a callback port until the timeout.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/setup-token/cancel',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx
        const session = getSetupTokenSession(agentControls)
        session.cancel()
        sendJson(res, 200, { ...session.status(), ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
