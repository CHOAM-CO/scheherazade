// onboarding/routes/settings.cjs -- settings-persistence routes (group 9)
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
'use strict'

function createRoutes(staticCtx) {
  const {
    sendJson, readJsonBody, writeAgentConfig,
  } = staticCtx
  return [
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/settings/rename',
      handler: async (req, res, callCtx) => {
        const { displayName } = await readJsonBody(req)
        if (!displayName || !displayName.trim()) {
          sendJson(res, 400, { error: 'displayName is required' })
          return
        }
        const merged = writeAgentConfig({ DISPLAY_NAME: displayName.trim() })
        sendJson(res, 200, { ok: true, config: merged })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
