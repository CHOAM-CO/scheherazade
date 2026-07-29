// onboarding/routes/mcp-connectors.cjs -- MCP connector management routes (group 4)
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
    sendJson, readJsonBody, readAgentConfig, connectorLaneWarning, listMcpConnectors,
    setMcpStatus, MCP_CONNECTOR_SPEC, startMcpConnectorLogin, getMcpStatus,
  } = staticCtx
  return [
    // ── MCP connector intercept (IA v0.0.9) ──────────────────────────────────
    // GET list: read-only, no token. Also reports the lane warning so the UI
    // can tell the user up front when the current lane can't USE connectors
    // even after authorizing (the load-bearing caveat, see connectorLaneWarning).
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/mcp-connectors',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const binPath = agentControls && typeof agentControls.resolveClaudeBin === 'function' ? agentControls.resolveClaudeBin() : null
        const laneWarning = connectorLaneWarning(readAgentConfig())
        if (!binPath) {
          sendJson(res, 200, { ok: false, reason: 'cli_missing', connectors: [], laneWarning })
          return
        }
        const connectors = await listMcpConnectors(binPath)
        sendJson(res, 200, { ok: true, connectors, laneWarning })
        return
      },
    },
    // POST login: mutating -> per-launch token gate (handled by the caller's
    // X-Onboard-Token check). Fire-and-forget; the client polls status.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/mcp-connector/login',
      handler: async (req, res, callCtx) => {
        const { agentControls } = callCtx // per-call value from createOnboardingServer, never staticCtx
        const { connectorName } = await readJsonBody(req)
        if (!connectorName || typeof connectorName !== 'string') {
          sendJson(res, 400, { error: 'connectorName is required' })
          return
        }
        const binPath = agentControls && typeof agentControls.resolveClaudeBin === 'function' ? agentControls.resolveClaudeBin() : null
        if (!binPath) {
          setMcpStatus(connectorName, 'failed', 'cli_missing', MCP_CONNECTOR_SPEC.installHint)
          sendJson(res, 200, { ok: false, reason: 'cli_missing' })
          return
        }
        startMcpConnectorLogin(connectorName, binPath)
        sendJson(res, 202, { ok: true })
        return
      },
    },
    // GET status: read-only poll. name via query string (handleApi gets only
    // pathname, so parse the query from req.url here).
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/mcp-connector/status',
      handler: async (req, res, callCtx) => {
        const name = new URL(req.url, 'http://127.0.0.1').searchParams.get('name')
        if (!name) {
          sendJson(res, 400, { error: 'name query param is required' })
          return
        }
        sendJson(res, 200, { name, ...getMcpStatus(name) })
        return
      },
    },
  ]
}

module.exports = { createRoutes }
