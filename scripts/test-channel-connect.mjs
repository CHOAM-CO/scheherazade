#!/usr/bin/env node
// test-channel-connect.mjs -- the multichannel (v0.0.18) server-side
// promises, attacked with fixture fetches (no live Telegram/Slack API
// anywhere in this file). Backend SCRIPT behavior (channel-telegram.mjs /
// channel-slack.mjs) has its own test files -- this one pins the wizard
// lane: enumeration branch codes, readiness computation, and the
// backend->script mapping .mcp.json is rewritten from.
//
// The promises, in the order they matter:
//   1. Branch codes are per-cause, never generic: a bad bot token, a bad
//      app token, a conflicting long-poll, and an empty chat list are four
//      DIFFERENT user actions -- the UI can only say the right sentence if
//      the server names the right branch.
//   2. Telegram's empty-chats case is ok:true (a fresh bot is not an
//      error); the 409 long-poll conflict is its own branch.
//   3. activeChannelBackend() falls back to discord on absent AND unknown
//      values -- a hand-edited config degrades, never bricks.
//
// Run: node scripts/test-channel-connect.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

process.env.AGENT_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-chconn-'))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { enumerateTelegramChats, enumerateSlackChannels, activeChannelBackend } = require_(
  path.join(ROOT, 'onboarding', 'http-server.cjs')
)

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

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

console.log('multichannel connect (telegram/slack enumeration + backend resolution)\n')

// ── telegram: happy path, chats deduped across updates ─────────────────────
{
  const fetchImpl = fakeFetch([
    ['/getMe', { body: { ok: true, result: { username: 'sched_bot' } } }],
    ['/getUpdates', { body: { ok: true, result: [
      { update_id: 1, message: { chat: { id: 100, type: 'private', first_name: 'Mino' } } },
      { update_id: 2, message: { chat: { id: 100, type: 'private', first_name: 'Mino' } } },
      { update_id: 3, message: { chat: { id: -200, type: 'group', title: 'CHOAM' } } },
    ] } }],
  ])
  const r = await enumerateTelegramChats('tok', fetchImpl)
  check('telegram happy path is ok', r.ok === true, JSON.stringify(r))
  check('bot username carried for the UI', r.bot && r.bot.username === 'sched_bot')
  check('chats deduped by id', r.chats.length === 2, JSON.stringify(r.chats))
  check('private chat labeled by name, group by title', r.chats[0].label === 'Mino' && r.chats[1].label === 'CHOAM')
}

// ── telegram: fresh bot, zero updates -> ok:true + empty (NOT an error) ────
{
  const fetchImpl = fakeFetch([
    ['/getMe', { body: { ok: true, result: { username: 'sched_bot' } } }],
    ['/getUpdates', { body: { ok: true, result: [] } }],
  ])
  const r = await enumerateTelegramChats('tok', fetchImpl)
  check('zero-updates bot is ok:true with empty chats', r.ok === true && r.chats.length === 0, JSON.stringify(r))
}

// ── telegram: bad token / long-poll conflict are separate branches ─────────
{
  const bad = await enumerateTelegramChats('tok', fakeFetch([
    ['/getMe', { status: 401, body: { ok: false, description: 'Unauthorized' } }],
  ]))
  check('401 getMe -> invalid_token branch', bad.ok === false && bad.branch === 'invalid_token', JSON.stringify(bad))

  const conflict = await enumerateTelegramChats('tok', fakeFetch([
    ['/getMe', { body: { ok: true, result: { username: 'sched_bot' } } }],
    ['/getUpdates', { status: 409, body: { ok: false, description: 'Conflict: terminated by other getUpdates' } }],
  ]))
  check('409 getUpdates -> conflict_running branch (its own user action)', conflict.ok === false && conflict.branch === 'conflict_running', JSON.stringify(conflict))

  const empty = await enumerateTelegramChats('', fakeFetch([]))
  check('empty token short-circuits to invalid_token (no network)', empty.ok === false && empty.branch === 'invalid_token')
}

// ── slack: happy path carries is_member per channel ────────────────────────
{
  const fetchImpl = fakeFetch([
    ['/auth.test', { body: { ok: true, team: 'CHOAM', user: 'sched' } }],
    ['/apps.connections.open', { body: { ok: true, url: 'wss://example' } }],
    ['/conversations.list', { body: { ok: true, channels: [
      { id: 'C1', name: 'general', is_member: true },
      { id: 'C2', name: 'random', is_member: false },
    ] } }],
  ])
  const r = await enumerateSlackChannels('xoxb-1', 'xapp-1', fetchImpl)
  check('slack happy path is ok', r.ok === true, JSON.stringify(r))
  check('team name carried for the UI', r.team === 'CHOAM')
  check('is_member carried per channel (invite hint depends on it)', r.channels[0].isMember === true && r.channels[1].isMember === false)
}

// ── slack: bot vs app token failures are DIFFERENT branches ────────────────
{
  const badBot = await enumerateSlackChannels('xoxb-bad', 'xapp-1', fakeFetch([
    ['/auth.test', { body: { ok: false, error: 'invalid_auth' } }],
  ]))
  check('bad bot token -> invalid_bot_token', badBot.ok === false && badBot.branch === 'invalid_bot_token', JSON.stringify(badBot))

  const badApp = await enumerateSlackChannels('xoxb-1', 'xapp-bad', fakeFetch([
    ['/auth.test', { body: { ok: true, team: 'CHOAM', user: 'sched' } }],
    ['/apps.connections.open', { body: { ok: false, error: 'invalid_auth' } }],
  ]))
  check('bad app token -> invalid_app_token (different fix, different branch)', badApp.ok === false && badApp.branch === 'invalid_app_token', JSON.stringify(badApp))

  const noBot = await enumerateSlackChannels('', 'xapp-1', fakeFetch([]))
  check('missing bot token short-circuits (no network)', noBot.ok === false && noBot.branch === 'invalid_bot_token')
  const noApp = await enumerateSlackChannels('xoxb-1', '', fakeFetch([]))
  check('missing app token short-circuits (no network)', noApp.ok === false && noApp.branch === 'invalid_app_token')
}

// ── backend resolution: absent and unknown both degrade to discord ─────────
{
  // AGENT_DATA_HOME is a fresh tmpdir -> no .agent-config at all.
  check('no config at all -> discord', activeChannelBackend() === 'discord')
  const cfgPath = path.join(process.env.AGENT_DATA_HOME, '.agent-config')
  fs.writeFileSync(cfgPath, 'CHANNEL_BACKEND=telegram\n')
  check('CHANNEL_BACKEND=telegram resolves', activeChannelBackend() === 'telegram')
  fs.writeFileSync(cfgPath, 'CHANNEL_BACKEND=SLACK\n')
  check('value is case-insensitive', activeChannelBackend() === 'slack')
  fs.writeFileSync(cfgPath, 'CHANNEL_BACKEND=matrix\n')
  check('unknown value degrades to discord (never bricks the boot path)', activeChannelBackend() === 'discord')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
