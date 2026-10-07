'use strict'
const os = require('node:os')
const { randomUUID } = require('node:crypto')
const { sessionValid, setSession } = require('../chromux-live-consent.cjs')
const { createService } = require('./pending-signal.cjs')
function createRoutes(ctx) {
  const { fs, path, DATA_HOME, sendJson, readJsonBody, readAgentConfig, checkForUpdate, APP_VERSION } = ctx
  const pile = createService(ctx)
  const channel = 'in-app' // channel-local.mjs LOCAL_CHANNEL_ID, also passed as SCHZ_CHANNEL_ID to the local lane.
  const consentDir = path.join(DATA_HOME, 'consent')
  fs.mkdirSync(consentDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(consentDir, 'app-boot-id'), randomUUID(), { mode: 0o600 })
  const stampFile = path.join(DATA_HOME, '.gates', 'whats-new.json')
  let pairedCache = null
  async function paired() {
    if (pairedCache && Date.now() - pairedCache.at < 60000) return pairedCache.value
    // paired is chromux's live /relay/status extensionConnected flag (no pairing token exists); read-only, 3s timeout, cached 60s.
    let value = false
    try {
      const home = process.env.CHROMUX_HOME || path.join(os.homedir(), '.chromux')
      let port = 47700
      try { const cfg = JSON.parse(fs.readFileSync(path.join(home, 'live.json'), 'utf8')); if (Number.isInteger(cfg.port) && cfg.port > 0 && cfg.port <= 65535) port = cfg.port } catch {}
      const response = await fetch(`http://127.0.0.1:${port}/relay/status`, { signal: AbortSignal.timeout(3000) })
      value = response.ok && (await response.json()).extensionConnected === true
    } catch {}
    pairedCache = { at: Date.now(), value }
    return value
  }
  async function status() {
    const update = await checkForUpdate()
    const { current } = await pile.readCurrent()
    let lastSeenVersion
    try { lastSeenVersion = JSON.parse(fs.readFileSync(stampFile, 'utf8')).lastSeenVersion } catch {}
    return { ok: true, current: APP_VERSION, latest: update.latest || APP_VERSION, hasUpdate: !!update.hasUpdate, unseenNotes: lastSeenVersion !== APP_VERSION, pending: pile.pendingOf(current, pile.readStamp()) }
  }
  async function post(content) {
    const ep = pile.readChannelEndpoint()
    if (!ep) throw new Error('Agent is offline')
    const result = await pile.postSystemTurn(ep, content)
    if (result.status !== 202) throw new Error('System turn was not accepted')
  }
  const route = (method, url, handler) => ({ method, match: p => p === url, handler: async (req, res) => {
    try { await handler(req, res) } catch (e) { sendJson(res, 500, { ok: false, reason: e.message }) }
  } })
  return [
    route('GET', '/api/quickbar/whats-new/status', async (req, res) => sendJson(res, 200, await status())),
    route('POST', '/api/quickbar/whats-new', async (req, res) => {
      const update = await checkForUpdate()
      const { current, proposals } = await pile.readCurrent()
      const filename = `release-notes-v${APP_VERSION}.md`
      let notes
      // __dirname remains inside app.asar when packaged, like other bundled documentation.
      try { notes = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', filename), 'utf8') }
      catch (e) { if (e.code !== 'ENOENT') throw e; notes = `Release notes file is missing: ${filename}. Do not invent notes.` }
      const content = ['[system] The user pressed What’s new.', notes,
        update.hasUpdate ? `A newer version ${update.latest} exists: ${update.url}` : (update.ok === false ? 'Update check unavailable; do not claim up to date.' : 'Up to date.'),
        pile.buildRecital(current, proposals),
        'Tell the user briefly in your own voice what changed in this version, whether an update exists, and what has piled up. No bullet dump of raw notes; mention only one version number.'].join('\n\n')
      // Prepare all stamp bytes before the one channel hop. A failed post never marks notes seen.
      fs.mkdirSync(path.dirname(stampFile), { recursive: true })
      const temp = `${stampFile}.${randomUUID()}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ lastSeenVersion: APP_VERSION, seenAtISO: new Date().toISOString() }), { mode: 0o600 })
      try { await post(content); fs.renameSync(temp, stampFile); pile.writeStamp(current) }
      finally { try { fs.unlinkSync(temp) } catch {} }
      sendJson(res, 200, { ok: true })
    }),
    route('POST', '/api/quickbar/look-back', async (req, res) => {
      await post('[system] The user pressed Look back. Read procedures/memory-consolidation.md and do its procedure WITH the user, live. First read what it reads: persona, recent episodic/session notes, and .review/reflux-proposals.md if present. Open in your own words with 2–3 things that changed or piled up since the last pass. Ask which to keep, merge, or drop, then WAIT. Write nothing until the user confirms. Apply only confirmed changes through the procedure’s own writes; report in one line what was written where. No schedule stamp, no AUTONOMY gate (the user requested this), no dream-talk.')
      sendJson(res, 202, { ok: true })
    }),
    route('GET', '/api/quickbar/browse/status', async (req, res) => {
      const config = readAgentConfig()
      let agentName = process.env.AGENT_NAME || 'agent'
      const ep = pile.readChannelEndpoint()
      if (ep) try { const r = await fetch(`http://127.0.0.1:${ep.port}/health`, { headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(3000) }); if (r.ok) agentName = (await r.json()).agent || agentName } catch {}
      sendJson(res, 200, { ok: true, enabled: config.BROWSE_LIVE === 'true', paired: await paired(), sessionConsent: sessionValid(DATA_HOME, channel), extensionPath: path.join(DATA_HOME, 'bin', 'chromux-portable', 'extension'), agentName })
    }),
    route('POST', '/api/quickbar/browse/session-consent', async (req, res) => {
      const body = await readJsonBody(req)
      if (typeof body.on !== 'boolean') return sendJson(res, 400, { ok: false, reason: 'on must be boolean' })
      if (body.on && (readAgentConfig().BROWSE_LIVE !== 'true' || !await paired())) return sendJson(res, 409, { ok: false, reason: 'Live Chrome is not connected' })
      setSession(DATA_HOME, channel, body.on)
      sendJson(res, 200, { ok: true })
    }),
  ]
}
module.exports = { createRoutes }
