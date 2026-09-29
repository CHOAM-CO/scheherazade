// channel-backends.cjs -- the ONE reading of which messengers are enabled.
//
// 0.3.7 (multi-channel): .agent-config grew a list form,
//   CHANNEL_BACKENDS=discord,slack        (order = priority; first = primary)
// next to the legacy single value
//   CHANNEL_BACKEND=discord
// Old installs only have the legacy key and must behave exactly as before
// (one channel) -- parseBackends() reads it when the list key is absent or
// yields nothing usable. Every write goes through backendConfigFields(), which
// emits BOTH keys with CHANNEL_BACKEND = the primary, so a rollback to an
// older build (which only reads CHANNEL_BACKEND) still boots the primary.
//
// CJS on purpose: main.cjs, onboarding/http-server.cjs and the ESM tests all
// load it (ESM channel processes get their role from env, not from here).

const KNOWN = ['discord', 'slack', 'telegram', 'local']
const MESSENGERS = ['discord', 'slack', 'telegram']

function normalizeList(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[,\s]+/)
  const out = []
  for (const p of parts) {
    const v = String(p).trim().toLowerCase()
    if (KNOWN.includes(v) && !out.includes(v)) out.push(v)
  }
  // 'local' is the in-app window; every messenger backend already hosts it
  // alongside, so it only stands as a backend when no messenger is enabled.
  if (out.length > 1 && out.includes('local')) return out.filter((b) => b !== 'local')
  return out
}

// config -> non-empty array of known backend names. Unknown/absent -> ['discord']
// (the degrade rule that has held since 0.0.18: a hand-edited config never bricks boot).
function parseBackends(config) {
  const c = config || {}
  const fromList = normalizeList(c.CHANNEL_BACKENDS)
  if (fromList.length) return fromList
  const legacy = normalizeList(c.CHANNEL_BACKEND)
  if (legacy.length) return legacy
  return ['discord']
}

function backendConfigFields(list) {
  const l = normalizeList(list)
  const use = l.length ? l : ['discord']
  return { CHANNEL_BACKENDS: use.join(','), CHANNEL_BACKEND: use[0] }
}

// Migrate-on-read: fields to write when the list key is missing (or disagrees
// with the legacy primary in a way only a hand edit could produce). null = nothing to do.
function migrationFields(config) {
  const c = config || {}
  const want = backendConfigFields(parseBackends(c))
  if (String(c.CHANNEL_BACKENDS || '') === want.CHANNEL_BACKENDS && String(c.CHANNEL_BACKEND || '').toLowerCase() === want.CHANNEL_BACKEND) return null
  return want
}

// Channel-id ownership, so the primary channel process can hand a tool call
// for another messenger's conversation to that messenger's process. The three
// id spaces are disjoint: Slack ids are letter-prefixed, Discord snowflakes
// are 15-25 digits, Telegram chat ids are <=14 digits (optionally negative).
function backendForChannelId(id) {
  const s = String(id == null ? '' : id).trim()
  if (!s) return null
  if (s === 'in-app') return 'local'
  if (/^[CDGUW][A-Z0-9]{6,}$/.test(s)) return 'slack'
  if (/^\d{15,25}$/.test(s)) return 'discord'
  if (/^-?\d{1,14}$/.test(s)) return 'telegram'
  return null
}

module.exports = { KNOWN, MESSENGERS, normalizeList, parseBackends, backendConfigFields, migrationFields, backendForChannelId }
