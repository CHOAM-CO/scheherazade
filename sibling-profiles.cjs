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
const LOOP_ERROR = '대화가 길어져서 여기서 끊어. 사람이 이어 줘'
// Process-local, bounded-age receipts, partitioned by receiver home and sender profile.
// Only local /in deliveries change these; platform notifications never do.
const receivedHops = new Map()
function hopState(dataHome) {
  let state = receivedHops.get(dataHome)
  if (!state) { state = new Map(); receivedHops.set(dataHome, state) }
  return state
}
function nextHop(dataHome, name, now = Date.now()) {
  const state = hopState(dataHome)
  const previous = state.get(name)
  if (previous && now - previous.at < 120000) return previous.hop + 1
  state.delete(name)
  return 1
}
function receiveHop(dataHome, name, hop, now = Date.now()) {
  const state = hopState(dataHome)
  if (!Number.isSafeInteger(hop) || hop < 1) throw failure('invalid sibling hop', 400)
  if (hop > 2) {
    state.delete(name)
    throw Object.assign(failure(LOOP_ERROR, 409), { code: 'sibling_loop' })
  }
  state.set(name, { hop, at: now })
}
function resetHops(dataHome) { receivedHops.delete(dataHome) }
async function post(p, payload) {
  try {
    const endpoint = JSON.parse(fs.readFileSync(path.join(p.dataHome, 'local-channel.json'), 'utf8'))
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string' || !endpoint.token) throw Error('invalid endpoint')
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/in`, { method: 'POST', headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload.sibling === true ? { hop: 1, ...payload } : payload), signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok) {
      let body
      try { body = await response.json() } catch {}
      if (response.status === 409 && body?.code === 'sibling_loop') throw Object.assign(failure(LOOP_ERROR, 409), { code: 'sibling_loop' })
      throw Error('listener unavailable')
    }
  } catch (error) {
    if (error.code === 'sibling_loop') throw error
    throw Object.assign(failure(`${displayName(p.dataHome) || p.name}은 지금 꺼져 있어`, 409), { code: 'profile_off' })
  }
}
async function say(dataHome, name, text) {
  if (typeof text !== 'string' || !text.trim()) throw failure('text required', 400)
  if (name === (profiles.profileFromHome(dataHome) || 'default')) throw failure('self', 400)
  if (name !== 'default') { try { profiles.validateName(name) } catch { throw failure('Invalid profile name', 400) } }
  const p = discover(dataHome).find(p => (p.name || 'default') === name)
  if (!p) throw failure('Profile not found', 404)
  const from = `${displayName(dataHome)} (${profiles.profileFromHome(dataHome) || 'default'})`
  await post(p, { text: text.trim(), from, sibling: true, hop: nextHop(dataHome, name) })
  return { ok: true }
}
module.exports = { discover, displayName, awareness, post, say, nextHop, receiveHop, resetHops }
