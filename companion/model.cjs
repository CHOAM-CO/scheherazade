'use strict'

const fs = require('node:fs')
const path = require('node:path')
const DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 45, sound: false })
const FACE = 64
const INSET = 12

function normalize(raw = {}) {
  if (!raw || typeof raw !== 'object') raw = {}
  const positions = Object.create(null)
  for (const [id, p] of Object.entries(raw.positions || {}).slice(0, 32)) {
    if (/^-?\d+$/.test(id) && p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      positions[id] = { x: Math.round(p.x), y: Math.round(p.y) }
    }
  }
  return { enabled: raw.enabled === true, positions,
    intervalMinutes: Number.isFinite(raw.intervalMinutes) ? Math.min(1440, Math.max(5, Math.round(raw.intervalMinutes))) : 45,
    sound: raw.sound === true,
    displayId: /^-?\d+$/.test(String(raw.displayId)) ? String(raw.displayId) : null }
}
function readState(home, log = () => {}) {
  try { return normalize(JSON.parse(fs.readFileSync(path.join(home, 'companion.json'), 'utf8'))) }
  catch (e) { if (e.code !== 'ENOENT') log(`companion: settings unreadable (${e.message})`); return normalize() }
}
function writeState(home, value) {
  const state = normalize(value)
  fs.mkdirSync(home, { recursive: true })
  const file = path.join(home, 'companion.json')
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  return state
}
function clampAnchor(anchor, area) {
  return { x: Math.round(Math.min(Math.max(anchor.x, area.x), area.x + Math.max(0, area.width - FACE))),
    y: Math.round(Math.min(Math.max(anchor.y, area.y), area.y + Math.max(0, area.height - FACE))) }
}
function initialAnchor(state, displays, primary) {
  const display = displays.find(d => String(d.id) === state.displayId) || primary
  const a = display.workArea
  const saved = state.positions[String(display.id)]
  return { display, anchor: clampAnchor(saved || { x: a.x + a.width - FACE - INSET, y: a.y + INSET }, a) }
}
function layout(anchor, area, expanded) {
  const a = clampAnchor(anchor, area)
  if (!expanded) return { bounds: { ...a, width: FACE, height: FACE }, face: { x: 0, y: 0 }, placement: 'left' }
  const left = a.x - area.x >= 332
  const width = Math.min(left ? 396 : 320, area.width)
  const height = Math.min(left ? 320 : 396, area.height)
  const x = Math.min(Math.max(left ? a.x - 332 : a.x, area.x), area.x + area.width - width)
  const above = !left && a.y + height > area.y + area.height
  const y = above ? Math.max(area.y, a.y + FACE - height) : Math.min(a.y, area.y + area.height - height)
  return { bounds: { x, y, width, height }, face: { x: a.x - x, y: a.y - y }, placement: left ? 'left' : above ? 'above' : 'below' }
}
function fullscreenDecision({ enabled, fullscreen, known = true }) {
  return { visible: !!enabled && !fullscreen, hiddenByFullscreen: !!enabled && !!fullscreen,
    proactiveAllowed: !!enabled && known && !fullscreen }
}
function canProactive({ now, bootAt, lastAt, intervalMinutes = 45, enabled, fullscreen, known = true, busy, bubble }) {
  return enabled && known && !fullscreen && !busy && !bubble && now - bootAt >= 120000 &&
    (lastAt === null || now - lastAt >= intervalMinutes * 60000)
}
function classifyMessage(m, awaiting = null) {
  if (!m || m.role !== 'agent' || m.kind !== 'message' || !String(m.text || '').trim()) return null
  const text = String(m.text)
  if (awaiting === 'proactive') return 'proactive'
  if (/(?:진행|실행|변경|삭제|설치|허용|해도).{0,30}(?:할까요|될까요|해도|괜찮|허락|승인)|\b(?:may I|can I|shall I|allow|approve|permission)\b/i.test(text)) return 'approval-reply'
  if (awaiting === 'reply') return 'reply'
  return /[?？]|(?:알려\s?주세요|골라\s?주세요|선택해\s?주세요)/.test(text) ? 'question' : null
}
module.exports = { DEFAULTS, FACE, INSET, normalize, readState, writeState, clampAnchor, initialAnchor, layout, fullscreenDecision, canProactive, classifyMessage }
