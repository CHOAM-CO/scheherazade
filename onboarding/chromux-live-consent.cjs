'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const TTL = 120000
const pendingConsent = new Map()
const key = (channel, argv) => createHash('sha256').update(JSON.stringify([channel, argv])).digest('hex')
const location = (home, channel, argv) => path.join(home, 'consent', key(channel, argv) + '.json')
function classify(argv) {
  if (['snapshot', 'screenshot', 'read', 'list', 'tabs', 'wait-for-text', 'wait-for-selector'].includes(argv[0])) return 'read'
  if (argv[0] === 'open' && argv.length === 4 && argv[2] === '--tab' && argv[3] === 'active') return 'read'
  return 'write'
}
function matcher(text, bot = false) {
  if (bot) return 'other'
  const t = String(text).trim()
  if (/^(ㅇㅇ|응|해|yes|y|ok|ㅇㅋ|go)(?:\s|[.!?]|$)/i.test(t)) return 'yes'
  if (/^(ㄴㄴ|아니|no|n|stop)(?:\s|[.!?]|$)/i.test(t)) return 'no'
  return 'other'
}
function receive(home, channel, text, bot = false, now = Date.now()) {
  if (!channel || bot) return false
  const p = path.join(home, 'consent', 'pending-' + key(channel, []) + '.json')
  try { pendingConsent.set(channel, JSON.parse(fs.readFileSync(p, 'utf8'))) } catch { return false }
  const action = pendingConsent.get(channel)
  const answer = matcher(text, bot)
  if (now - action.askedAt > TTL || answer === 'no' || answer === 'yes') {
    fs.unlinkSync(p); pendingConsent.delete(channel)
    if (now - action.askedAt <= TTL && answer === 'yes') {
      fs.writeFileSync(location(home, channel, action.argv), JSON.stringify({ issuedAt: now, askedAt: action.askedAt, argv: action.argv, channel }), { mode: 0o600 })
      return true
    }
  }
  return false
}
module.exports = { TTL, key, location, classify, matcher, receive, pendingConsent }
