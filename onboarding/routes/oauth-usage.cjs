// onboarding/routes/oauth-usage.cjs -- full-scope OAuth capture for the usage
// gauge (group 13). Thin, exactly like the setup-token routes it mirrors:
// every handler delegates to the session object and returns its status(). The
// ONE extra thing this exposes that setup-token does not is the authorize
// URL, and it is emitted from start() only -- a fixed-shape URL the module
// built, never a caller-supplied or credential-derived string.
//
// The credential never comes back through these routes. status() carries
// fixed enum members and a clock reading; the access/refresh tokens live and
// die inside oauth-usage-session.cjs and the credential store.
'use strict'

function createRoutes(staticCtx) {
  const { sendJson, getUsageOAuthSession } = staticCtx
  return [
    // POST start: mutating -> per-launch token gate (the caller's
    // X-Onboard-Token check, same as every other POST). Fire-and-forget; the
    // client opens the returned authorizeUrl and then polls status. 202 with
    // the URL on a started or already-running flow, 409 when the loopback
    // listener cannot bind at all.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/usage-login/start',
      handler: async (req, res) => {
        const session = getUsageOAuthSession()
        const result = await session.start()
        if (!result.ok) {
          sendJson(res, 409, { ...session.status(), ok: false, reason: result.reason })
          return
        }
        // authorizeUrl is present on a fresh start; on a re-entrant start
        // against a live flow it may be null (the UI keeps the URL it has).
        sendJson(res, 202, { ...session.status(), ok: true, authorizeUrl: result.authorizeUrl || null })
        return
      },
    },
    // GET status: read-only poll, no token gate -- fixed enum members and a
    // clock only, same guarantee as setup-token's status route.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/usage-login/status',
      handler: async (req, res) => {
        sendJson(res, 200, getUsageOAuthSession().status())
        return
      },
    },
    // POST cancel: user backed out. Closes the loopback listener so an
    // abandoned flow does not sit on a callback port until the timeout.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/usage-login/cancel',
      handler: async (req, res) => {
        const session = getUsageOAuthSession()
        session.cancel()
        sendJson(res, 200, { ...session.status(), ok: true })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
