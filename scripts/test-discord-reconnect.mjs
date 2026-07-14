#!/usr/bin/env node
// test-discord-reconnect.mjs -- the reconnect lane's enumerate/apply promises,
// attacked with fixture fetches (no live Discord API anywhere in this file).
//
// The promises, in the order they matter:
//   1. Enumerate NEVER auto-picks. Onboarding's "first guild, first text
//      channel" inference is for freshly-created single-server installs; a
//      reconnect user is switching on purpose, so the server returns
//      candidates and only candidates.
//   2. The apply route re-verifies the pick against the token AT APPLY TIME
//      and never rewrites onboarding history (ONBOARDING_COMPLETE /
//      ONBOARDING_COMPLETED_AT / ONBOARDING_STEP are records of when
//      onboarding happened -- a reconnect is not an onboarding).
//   3. Caps are reported, never silent (truncated flag).
//
// Wrong-defendant discipline: every fetch is a local fixture; nothing here
// can convict the machine, the network, or a dotfile.
//
// Run: node scripts/test-discord-reconnect.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

process.env.AGENT_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-reconnect-'))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { enumerateDiscordTargets } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// Fixture fetch: routes DISCORD API paths to canned responses.
function fakeFetch(routes) {
  return async (url) => {
    for (const [suffix, responder] of routes) {
      if (url.endsWith(suffix) || url.includes(suffix)) {
        const r = typeof responder === 'function' ? responder(url) : responder
        return {
          ok: r.status ? r.status < 400 : true,
          status: r.status || 200,
          json: async () => r.body,
        }
      }
    }
    throw new Error(`fixture has no route for ${url}`)
  }
}

const INTENT_ON = 1 << 18

console.log('discord reconnect (enumerate + apply pins)\n')

// ── 1. Happy path: enumerate, no auto-pick, channels filtered + sorted ─────
{
  const fetchImpl = fakeFetch([
    ['/users/@me/guilds', { body: [ { id: 'g1', name: 'Alpha' }, { id: 'g2', name: 'Beta' } ] }],
    ['/users/@me', { body: { id: 'bot' } }],
    ['/oauth2/applications/@me', { body: { flags: INTENT_ON } }],
    ['/guilds/g1/channels', { body: [
      { id: 'c2', name: 'second', type: 0, position: 2 },
      { id: 'v1', name: 'voice', type: 2, position: 0 },
      { id: 'c1', name: 'first', type: 0, position: 1 },
    ] }],
    ['/guilds/g2/channels', { body: [] }],
  ])
  const r = await enumerateDiscordTargets('tok', fetchImpl)
  check('enumerates ALL guilds (no first-guild auto-pick)', r.ok && r.guilds.length === 2, JSON.stringify(r))
  check('...and carries names for the picker UI', r.guilds[0].name === 'Alpha' && r.guilds[1].name === 'Beta')
  check('non-text channels are filtered out', r.guilds[0].channels.every((c) => c.id !== 'v1'))
  check('text channels sorted by position', r.guilds[0].channels.map((c) => c.id).join(',') === 'c1,c2', JSON.stringify(r.guilds[0].channels))
  check('a guild with zero text channels still appears (the USER decides what that means)', r.guilds[1].channels.length === 0)
  check('no truncation flag when under the cap', r.truncated === false)
  check('result has NO auto-picked channelId field', !('channelId' in r) && !('guildId' in r), JSON.stringify(Object.keys(r)))
}

// ── 2. The three validation branches match onboarding's own ────────────────
{
  const bad = await enumerateDiscordTargets('tok', fakeFetch([['/users/@me', { status: 401, body: {} }]]))
  check('rejected token -> invalid_token', !bad.ok && bad.branch === 'invalid_token')

  const noIntent = await enumerateDiscordTargets('tok', fakeFetch([
    ['/users/@me/guilds', { body: [] }],
    ['/users/@me', { body: {} }],
    ['/oauth2/applications/@me', { body: { flags: 0 } }],
  ]))
  check('missing MESSAGE CONTENT intent -> intent_off', !noIntent.ok && noIntent.branch === 'intent_off')

  const lonely = await enumerateDiscordTargets('tok', fakeFetch([
    ['/users/@me/guilds', { body: [] }],
    ['/users/@me', { body: {} }],
    ['/oauth2/applications/@me', { body: { flags: INTENT_ON } }],
  ]))
  check('bot in zero guilds -> not_invited', !lonely.ok && lonely.branch === 'not_invited')

  const empty = await enumerateDiscordTargets('   ', fakeFetch([]))
  check('blank token short-circuits without any fetch', !empty.ok && empty.branch === 'invalid_token')
}

// ── 3. The cap is loud, never silent ────────────────────────────────────────
{
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, name: `G${i}` }))
  const routes = [
    ['/users/@me/guilds', { body: many }],
    ['/users/@me', { body: {} }],
    ['/oauth2/applications/@me', { body: { flags: INTENT_ON } }],
  ]
  for (let i = 0; i < 12; i++) routes.push([`/guilds/g${i}/channels`, { body: [{ id: `c${i}`, name: 'general', type: 0, position: 0 }] }])
  const r = await enumerateDiscordTargets('tok', fakeFetch(routes))
  check('guild fan-out capped at 10', r.ok && r.guilds.length === 10, `${r.guilds && r.guilds.length}`)
  check('...and the cap is REPORTED (truncated: true)', r.truncated === true)
}

// ── 4. A channels fetch failure fails LOUD, not partial ────────────────────
{
  let threw = false
  try {
    await enumerateDiscordTargets('tok', fakeFetch([
      ['/users/@me/guilds', { body: [{ id: 'g1', name: 'A' }] }],
      ['/users/@me', { body: {} }],
      ['/oauth2/applications/@me', { body: { flags: INTENT_ON } }],
      ['/guilds/g1/channels', { status: 500, body: {} }],
    ]))
  } catch { threw = true }
  check('channels fetch failure throws (no silently-partial guild list)', threw)
}

// ── 5. Source pins: the routes keep their promises ──────────────────────────
{
  const src = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  const applyStart = src.indexOf("'/api/discord/reconnect/apply'")
  const applyEnd = src.indexOf("'/api/proxy/health'")
  check('apply route exists (and this pin can bracket it)', applyStart > 0 && applyEnd > applyStart)
  const applyBlock = src.slice(applyStart, applyEnd)
  check('apply NEVER writes onboarding stamps (no ONBOARDING_ anywhere in the block)', !applyBlock.includes('ONBOARDING_'))
  check('apply re-verifies the pick server-side (enumerate called inside apply)', applyBlock.includes('enumerateDiscordTargets(effective)'))
  check('apply persists display names for the connectors page', applyBlock.includes('HOME_GUILD_NAME') && applyBlock.includes('HOME_CHANNEL_NAME'))
  check('apply restarts the agent (fresh spawn re-reads token+channel)', applyBlock.includes('agentControls.restartAgent'))
  check('validate route reports stored-token fallback (usedStoredToken)', src.includes('usedStoredToken'))
  const validateBlock = src.slice(src.indexOf("'/api/discord/reconnect/validate'"), applyStart)
  check('validate route has NO side effects (no store/write calls)', !validateBlock.includes('storeDiscordTokenVerified') && !validateBlock.includes('writeEnv') && !validateBlock.includes('writeAgentConfig'))

  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  check('main.cjs exposes proxyHealth in agentControls', /agentControls = \{[^}]*proxyHealth/.test(mainSrc))
  check('proxyHealth reports the LIVE /health fetch, never codexProxyModel', mainSrc.includes('async function proxyHealth') && /proxyHealth\(\) \{(?:(?!codexProxyModel)[\s\S])*?\n\}/.test(mainSrc.slice(mainSrc.indexOf('async function proxyHealth'), mainSrc.indexOf('const agentControls'))))
  check('http-server serves GET /api/proxy/health via the injected control', src.includes("'/api/proxy/health'") && src.includes('agentControls.proxyHealth'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
