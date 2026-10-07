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
const SESSION_TTL = 8 * 60 * 60 * 1000
const sessionLocation = (home, channel) => path.join(home, 'consent', 'session-' + key(channel, []) + '.json')
function bootId(home) {
  try { return fs.readFileSync(path.join(home, 'consent', 'app-boot-id'), 'utf8').trim() } catch { return '' }
}
function sessionValid(home, channel, now = Date.now()) {
  try {
    const s = JSON.parse(fs.readFileSync(sessionLocation(home, channel), 'utf8'))
    const granted = Date.parse(s.grantedAtISO), expires = Date.parse(s.expiresAtISO), boot = bootId(home)
    return !!boot && s.bootId === boot && granted <= now && now < expires && expires - granted <= SESSION_TTL
  } catch { return false }
}
function setSession(home, channel, on, now = Date.now()) {
  const dir = path.join(home, 'consent')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (on) {
    const boot = bootId(home)
    if (!boot) throw new Error('App boot identity unavailable')
    fs.writeFileSync(sessionLocation(home, channel), JSON.stringify({ bootId: boot, grantedAtISO: new Date(now).toISOString(), expiresAtISO: new Date(now + SESSION_TTL).toISOString() }), { mode: 0o600 })
  } else {
    const remove = file => { try { fs.unlinkSync(file) } catch (e) { if (e.code !== 'ENOENT') throw e } }
    remove(sessionLocation(home, channel))
    remove(path.join(dir, 'pending-' + key(channel, []) + '.json'))
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
      const file = path.join(dir, name)
      let record
      try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { continue }
      if (record.channel === channel) remove(file)
    }
  }
}
module.exports = { SESSION_TTL, sessionLocation, sessionValid, setSession, bootId, TTL, key, location, classify, matcher, receive, pendingConsent }
