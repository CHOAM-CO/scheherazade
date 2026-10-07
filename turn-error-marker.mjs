// turn-error-marker.mjs -- the ONE writer/clearer of DATA_HOME/.last-turn-error.json.
//
// headless-lane.mjs wrote this marker inline on an errored `result` event and
// the UI (GET /api/agent/turn-error -> nav banner + chat divider) reads it.
// dsh-lane.mjs never wrote it (Mino 2026-10-07 16:37: a DeepSeek INVALID_REQUEST
// left "nothing in the app"; app.log held only the code, the provider's HTTP
// body was dropped). Isolated here so the dsh lane -- not importable in a
// test, it binds its server at module scope -- can be exercised through this
// module directly. Shape is the route's contract: { ts, subtype, detail }.

import fs from 'node:fs'
import path from 'node:path'

export const TURN_ERROR_MARKER = '.last-turn-error.json'
export const TURN_ERROR_DETAIL_MAX = 500

export function markerPath (dataHome) {
  return path.join(dataHome, TURN_ERROR_MARKER)
}

function writeJsonAtomic (file, obj, mode) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: mode || 0o600 })
  fs.renameSync(tmp, file)
}

// One-line summary for the lane log: the code AND the provider's text
// (pi-ai's errorMessage = HTTP status + body), capped so a 20KB HTML error
// page cannot flood app.log.
export function turnErrorLogLine (code, message) {
  const msg = String(message || '').replace(/\s+/g, ' ').trim().slice(0, TURN_ERROR_DETAIL_MAX)
  return `turn end (error: ${code || 'unknown'})${msg ? ` ${msg}` : ''}`
}

// Returns the marker object written, or null when the write failed (the
// caller logs; a marker that cannot be written must not kill the lane).
export function writeTurnErrorMarker (dataHome, { code, message, model, now = Date.now() } = {}) {
  const msg = String(message || '').replace(/\s+/g, ' ').trim().slice(0, TURN_ERROR_DETAIL_MAX)
  const marker = {
    ts: now,
    subtype: String(code || 'error'),
    detail: `${model || 'model'}: ${msg || 'no detail carried by the provider'}`,
  }
  writeJsonAtomic(markerPath(dataHome), marker, 0o600)
  return marker
}

export function clearTurnErrorMarker (dataHome) {
  try { fs.unlinkSync(markerPath(dataHome)); return true } catch { return false } // absent = nothing to clear
}
