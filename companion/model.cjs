'use strict'

const fs = require('node:fs')
const path = require('node:path')
const DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 45, sound: false })
const FACE = 64
const INSET = 12
// Config keys live in the agent config next to TTS_ENABLED / STT_ENABLED;
// companion.json keeps window positions and the 0026 bubble options only.
const VARIANTS = Object.freeze(['face', 'orb'])
const DEFAULT_VARIANT = 'face'
// Collapsed surface per variant. The orb box holds a 200 px canvas (ring plus
// glow) and the 40 px hover control row under it.
const SIZES = Object.freeze({ face: Object.freeze({ width: FACE, height: FACE }), orb: Object.freeze({ width: 200, height: 252 }) })
const sizeOf = variant => SIZES[variant] || SIZES.face
function readConfig(cfg = {}) {
  const variant = VARIANTS.includes(cfg.COMPANION_VARIANT) ? cfg.COMPANION_VARIANT : DEFAULT_VARIANT
  return { enabled: cfg.COMPANION_ENABLED === 'true', variant }
}

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
function clampAnchor(anchor, area, size = SIZES.face) {
  return { x: Math.round(Math.min(Math.max(anchor.x, area.x), area.x + Math.max(0, area.width - size.width))),
    y: Math.round(Math.min(Math.max(anchor.y, area.y), area.y + Math.max(0, area.height - size.height))) }
}
function initialAnchor(state, displays, primary, size = SIZES.face) {
  const display = displays.find(d => String(d.id) === state.displayId) || primary
  const a = display.workArea
  const saved = state.positions[String(display.id)]
  return { display, anchor: clampAnchor(saved || { x: a.x + a.width - size.width - INSET, y: a.y + INSET }, a, size) }
}
// Measured renderer surface: 64px face, or 200px orb + 52px controls.
// The drawn orb radius is 0.3 × canvas width: its transparent side inset is
// 40px. Tuck into that inset for a 12px visible-ring gap; controls begin at 30px.
// Flip horizontally first, then vertically on narrow displays.
function layout(anchor, area, expanded, size = SIZES.face, bubbleHeight = 320) {
  const a = clampAnchor(anchor, area, size)
  if (!expanded) return { bounds: { ...a, width: size.width, height: size.height }, face: { x: 0, y: 0 }, size, bubbleTop: 0, placement: 'left' }
  const bw = Math.min(320, area.width), bh = Math.min(320, Math.max(1, bubbleHeight), area.height)
  const gap = size.width === size.height ? 12 : 12 - size.width * 0.2
  const left = a.x - area.x >= bw + gap
  const right = area.x + area.width - a.x - size.width >= bw + gap
  let bx, by, placement
  if (left || right) {
    placement = left ? 'left' : 'right'
    bx = left ? a.x - bw - gap : a.x + size.width + gap
    // Align with the ring/face, never with the control row below it.
    by = Math.max(area.y, Math.min(a.y + (size.width - bh) / 2, area.y + area.height - bh))
  } else {
    const below = area.y + area.height - a.y - size.height
    const above = a.y - area.y
    placement = below >= bh + 12 || below >= above ? 'below' : 'above'
    bx = Math.max(area.x, Math.min(a.x + (size.width - bw) / 2, area.x + area.width - bw))
    by = placement === 'below' ? a.y + size.height + 12 : a.y - bh - 12
    by = Math.max(area.y, Math.min(by, area.y + area.height - bh))
  }
  bx = Math.round(bx); by = Math.round(by)
  const x = Math.min(a.x, bx), y = Math.min(a.y, by)
  return { bounds: { x, y, width: Math.max(a.x + size.width, bx + bw) - x, height: Math.max(a.y + size.height, by + bh) - y },
    face: { x: a.x - x, y: a.y - y }, size, bubbleLeft: bx - x, bubbleTop: by - y, placement }
}
// Native window regions use integer DIP rectangles. Scanlines approximate the
// visible circles/rounded bubble without sampling or recording cursor position.
function hitShape(geometry, bubbleHeight = 0) {
  const rectangles = []
  function rounded(x, y, width, height, radius) {
    for (let row = 0; row < height; row++) {
      const distance = row < radius ? radius - row - 0.5 : row >= height - radius ? row - (height - radius) + 0.5 : 0
      const inset = distance ? Math.ceil(radius - Math.sqrt(Math.max(0, radius * radius - distance * distance))) : 0
      rectangles.push({ x: x + inset, y: y + row, width: Math.max(1, width - inset * 2), height: 1 })
    }
  }
  const size = geometry.size || SIZES.face
  // Face = circle. Orb = rounded box so the control row under the ring stays clickable.
  rounded(geometry.face.x, geometry.face.y, size.width, size.height, size.width === size.height ? size.width / 2 : 24)
  if (bubbleHeight > 0) rounded(geometry.bubbleLeft || 0, geometry.bubbleTop ?? (geometry.placement === 'below' ? FACE + 12 : 0),
    Math.min(320, geometry.bounds.width), Math.min(320, Math.ceil(bubbleHeight)), 14)
  return rectangles
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
// Same filter chat.js applies before read-aloud: completed agent messages,
// not system lines ("[system]" within the first 8 chars), not activity items.
function speakable(m) {
  if (!m || (m.kind && m.kind !== 'message') || m.role !== 'agent' || typeof m.text !== 'string' || !m.text.trim()) return false
  const i = m.text.indexOf('[system]')
  return i === -1 || i > 8
}
module.exports = { speakable, DEFAULTS, FACE, INSET, VARIANTS, DEFAULT_VARIANT, SIZES, sizeOf, readConfig, normalize, readState, writeState, clampAnchor, initialAnchor, layout, hitShape, fullscreenDecision, canProactive, classifyMessage }
