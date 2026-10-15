'use strict'
const fs = require('node:fs')
const path = require('node:path')
const profiles = require('./profile.cjs')
function discover(dataHome) {
  let entries
  try { entries = fs.readdirSync(path.dirname(dataHome), { withFileTypes: true }) } catch { return [] }
  return entries.filter(e => e.isDirectory() && e.name !== path.basename(dataHome) && (e.name === 'Scheherazade' || /^Scheherazade-[a-z0-9-]{1,24}$/.test(e.name) && e.name !== 'Scheherazade-default')).map(e => {
    const home = path.join(path.dirname(dataHome), e.name)
    const name = profiles.profileFromHome(home)
    return { name, dataHome: home, folder: e.name }
  }).filter(p => {
    try { const config = fs.readFileSync(path.join(p.dataHome, '.agent-config'), 'utf8'); return !p.name || config.match(/^PROFILE=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') === p.name } catch { return false }
  }).sort((a, b) => a.name.localeCompare(b.name))
}
function displayName(home) {
  try { return fs.readFileSync(path.join(home, '.agent-config'), 'utf8').match(/^DISPLAY_NAME=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || 'Scheherazade' } catch { return 'Scheherazade' }
}
const liveCache = new Map()
function cachedAlive(p, liveness) {
  const old = liveCache.get(p.dataHome)
  if (old && Date.now() - old.at < 5000) return old.value
  const value = profiles.pidAlive(p.dataHome, { ...liveness, name: p.name })
  liveCache.set(p.dataHome, { at: Date.now(), value })
  return value
}
function awareness(dataHome, liveness = {}) {
  return discover(dataHome).map(p => `다른 세라: ${displayName(p.dataHome)} (${p.name || 'default'}, ${cachedAlive(p, liveness) ? '켜짐' : '꺼짐'})`)
}
function failure(error, status) { return Object.assign(new Error(error), { status }) }
async function post(p, payload) {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(p.dataHome, 'local-channel.json'), 'utf8'))
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string' || !endpoint.token) throw Error('invalid endpoint')
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/in`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok) throw Error('listener unavailable')
  } catch { throw Object.assign(failure(`${displayName(p.dataHome) || p.name}은 지금 꺼져 있어`, 409), { code: 'profile_off' }) }
}
async function say(dataHome, name, text) {
  if (typeof text !== 'string' || !text.trim()) throw failure('text required', 400)
  if (name === (profiles.profileFromHome(dataHome) || 'default')) throw failure('self', 400)
  if (name !== 'default') { try { profiles.validateName(name) } catch { throw failure('Invalid profile name', 400) } }
  const p = discover(dataHome).find(p => (p.name || 'default') === name)
  if (!p) throw failure('Profile not found', 404)
  const from = `${displayName(dataHome)} (${profiles.profileFromHome(dataHome) || 'default'})`
  await post(p, { text: text.trim(), from, sibling: true })
  return { ok: true }
}
module.exports = { discover, displayName, awareness, post, say }
