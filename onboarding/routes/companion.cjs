'use strict'

// Uses the same authenticated route table and local system-turn bridge as the
// pending recital. No new renderer privilege, provider call, or approval API.
// Gate (design-0027): COMPANION_ENABLED in the agent config, default off.
// Every action except 'settings' is refused with 409 while it is off, here
// AND in the controller, so nothing can open the window behind the toggle.
const { readConfig: parseConfig, VARIANTS } = require('../../companion/model.cjs')
const ACTIONS = new Set(['settings', 'pointer', 'shape', 'touch', 'dismiss', 'open', 'drag-start', 'drag-end', 'reply', 'main', 'call-error', 'call-speaking'])

function createRoutes(ctx) {
  const { sendJson, readJsonBody, readAgentConfig, writeAgentConfig } = ctx
  const bridge = require('./pending-signal.cjs').createService(ctx)
  const config = () => { try { return parseConfig(readAgentConfig()) } catch { return parseConfig() } }
  return [
    { method: 'GET', match: p => p === '/api/companion', handler: async (_req, res, call) => {
      const companion = call.agentControls?.companion?.()
      sendJson(res, 200, companion ? companion.snapshot() : { available: false, ...config() })
    } },
    { method: 'POST', match: p => p === '/api/companion', handler: async (req, res, call) => {
      const companion = call.agentControls?.companion?.()
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || !ACTIONS.has(body.action)) return sendJson(res, 400, { error: 'invalid companion command' })
      if (body.action !== 'settings' && !config().enabled && !companion?.snapshot().callHud) return sendJson(res, 409, { error: 'companion disabled' })
      if (!companion) {
        // Browser-only (no Electron): the toggle still persists, nothing opens.
        if (body.action !== 'settings') return sendJson(res, 503, { error: 'companion unavailable' })
        if ((body.enabled !== undefined && typeof body.enabled !== 'boolean') || (body.variant !== undefined && !VARIANTS.includes(body.variant)))
          return sendJson(res, 400, { error: 'invalid companion command' })
        const fields = { ...(body.enabled === undefined ? {} : { COMPANION_ENABLED: String(body.enabled) }),
          ...(body.variant === undefined ? {} : { COMPANION_VARIANT: body.variant }) }
        if (Object.keys(fields).length) writeAgentConfig(fields)
        return sendJson(res, 200, { available: false, ...config() })
      }
      try { sendJson(res, 200, await companion.command(body)) }
      catch (e) {
        if (e.code === 'BAD_COMMAND') return sendJson(res, 400, { error: 'invalid companion command' })
        if (e.code === 'DISABLED') return sendJson(res, 409, { error: 'companion disabled' })
        throw e
      }
    } },
    { method: 'POST', match: p => p === '/api/companion/nudge', handler: async (_req, res, call) => {
      const companion = call.agentControls?.companion?.()
      if (!config().enabled || !companion?.claimNudge()) return sendJson(res, 200, { injected: false })
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
