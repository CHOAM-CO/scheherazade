'use strict'

// Uses the same authenticated route table and local system-turn bridge as the
// pending recital. No new renderer privilege, provider call, or approval API.
function createRoutes(ctx) {
  const { sendJson, readJsonBody } = ctx
  const bridge = require('./pending-signal.cjs').createService(ctx)
  return [
    { method: 'GET', match: p => p === '/api/companion', handler: async (_req, res, call) => {
      const companion = call.agentControls?.companion?.()
      sendJson(res, 200, companion ? companion.snapshot() : { available: false, enabled: false })
    } },
    { method: 'POST', match: p => p === '/api/companion', handler: async (req, res, call) => {
      const companion = call.agentControls?.companion?.()
      if (!companion) return sendJson(res, 503, { error: 'companion unavailable' })
      const body = await readJsonBody(req)
      try { sendJson(res, 200, await companion.command(body)) }
      catch (e) { if (e.code === 'BAD_COMMAND') return sendJson(res, 400, { error: 'invalid companion command' }); throw e }
    } },
    { method: 'POST', match: p => p === '/api/companion/nudge', handler: async (_req, res, call) => {
      const companion = call.agentControls?.companion?.()
      if (!companion?.claimNudge()) return sendJson(res, 200, { injected: false })
      const ep = bridge.readChannelEndpoint()
      const result = ep ? await bridge.postSystemTurn(ep,
        '[SYSTEM: desktop companion] If you have something genuinely useful to say to the user from the current conversation, say one short line in your own voice on the local chat. No tools, no task execution, no invented reminders. If there is nothing useful, do not reply. This is not a user request.') : null
      const injected = result?.status === 202
      companion.nudgeResult(injected)
      sendJson(res, 200, { injected })
    } },
  ]
}
module.exports = { createRoutes }
