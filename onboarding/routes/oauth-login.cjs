// onboarding/routes/oauth-login.cjs -- in-app Claude login for the AGENT LANE
// (group 15). The browser replacement for `claude setup-token`: it runs the
// exact same OAuth machinery as the usage-gauge login (routes/oauth-usage.cjs,
// which this file mirrors line-for-line), but the session behind it requests
// only user:inference and stores the raw oat as 'claude-subscription' -- see
// getLoginOAuthSession() in http-server.cjs. Dropping the CLI dependency for
// login is the WHOLE point, so nothing here spawns or resolves a binary.
//
// Same no-echo posture as every OAuth route: the credential never returns
// through these handlers. status() carries fixed enum members and a clock
// only; the token lives and dies inside oauth-usage-session.cjs and the
// credential store. The one caller-visible extra is the authorize URL, built
// by the module from fixed constants, emitted from start() only.
'use strict'

function createRoutes(staticCtx) {
  const { sendJson, getLoginOAuthSession } = staticCtx
  return [
    // POST start: mutating -> per-launch token gate (the caller's
    // X-Onboard-Token check, same as every other POST). Fire-and-forget; the
    // client opens the returned authorizeUrl and then polls status. 202 with
    // the URL on a started or already-running flow, 409 when the loopback
    // listener cannot bind at all -- carries a human `error` so the client's
    // api() surfaces a readable line instead of a bare "HTTP 409".
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/claude-login/start',
      handler: async (req, res) => {
        const session = getLoginOAuthSession()
        const result = await session.start()
        if (!result.ok) {
          sendJson(res, 409, {
            ...session.status(),
            ok: false,
            reason: result.reason,
            error: 'Could not start the login on this machine (the local callback listener would not bind). Try again, or restart the app.',
          })
          return
        }
        // authorizeUrl is present on a fresh start; on a re-entrant start
        // against a live flow it may be null (the UI keeps the URL it has).
        sendJson(res, 202, { ...session.status(), ok: true, authorizeUrl: result.authorizeUrl || null })
        return
      },
    },
    // GET status: read-only poll, no token gate -- fixed enum members and a
    // clock only, same guarantee as the usage/setup-token status routes.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/claude-login/status',
      handler: async (req, res) => {
        sendJson(res, 200, getLoginOAuthSession().status())
        return
      },
    },
    // POST cancel: user backed out. Closes the loopback listener so an
    // abandoned flow does not sit on a callback port until the timeout.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/claude-login/cancel',
      handler: async (req, res) => {
        const session = getLoginOAuthSession()
        session.cancel()
        sendJson(res, 200, { ...session.status(), ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
