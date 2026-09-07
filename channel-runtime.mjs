// channel-runtime.mjs — protocol-neutral runtime layer shared by every
// channel backend (channel.mjs / channel-slack.mjs / channel-telegram.mjs).
//
// Zero transport imports, on purpose: everything here is about the MCP stdio
// contract, the DATA_HOME marker files, and the outbound-target ladder — none
// of which belongs to Discord, Slack, or Telegram. Backends keep only
// transport behavior: client/login, fetch-target and send implementations,
// message normalization, event wiring. tests/test-channel-runtime.mjs is
// the tripwire that keeps it that way.
//
// resolveDataHome() delegates to data-home.cjs, the ONE resolution
// (`MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"`): same env var,
// same fallback, keyed by AGENT_NAME. main.cjs / onboarding/http-server.cjs
// compute DATA_HOME independently and poll the marker files written here —
// a drifted formula makes the agent invisible to its own supervisor.
// (history: docs/HISTORY.md)

import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveDataHome as resolveHome } from './data-home.cjs'

// cadence/boot-announce.cjs is CommonJS on purpose (one decision module, two
// callers — this file and onboarding/http-server.cjs, which cannot import ESM).
const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

// ── stdout hygiene ─────────────────────────────────────────────────────────
// MCP stdio transport reserves stdout exclusively for JSON-RPC. Any stray
// console output there corrupts the stream, so every console method is
// rerouted to stderr. Backends call this before anything else runs.
function safeJson(v) { try { return JSON.stringify(v) } catch { return String(v) } }

export function installStdoutHygiene() {
  for (const [method, prefix] of [['log', ''], ['info', ''], ['debug', ''], ['warn', '[WARN] '], ['error', '[ERR] ']]) {
    console[method] = (...args) => {
      process.stderr.write(`${prefix}${args.map((a) => (typeof a === 'string' ? a : safeJson(a))).join(' ')}\n`)
    }
  }
  return (...args) => console.log(...args)
}

// ── DATA_HOME ──────────────────────────────────────────────────────────────
// Resolved explicitly, never from process.cwd(): a differently-spawned
// process must not silently write markers where no poller looks.
export function resolveDataHome(agentName) {
  // Delegated to the one resolver (data-home.cjs, design-0023 P3) so the
  // channel backends, the hooks, the supervisor and the memory DB can never
  // disagree about where the agent lives. Same precedence, same default.
  return resolveHome({ agentName })
}

// ── atomic JSON write (temp file + rename) ─────────────────────────────────
// Shared with the supervisor's failure-marker convention: pollers read these files
// on a timer, and a plain writeFile leaves a window where a poll tick lands
// mid-write and JSON.parses a truncated read. fs.rename is atomic on the
// same filesystem, which a temp file in the same directory always is.
export async function atomicWriteJson(filePath, payload) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2) + '\n')
  await fs.rename(tmpPath, filePath)
}

// ── local-time timestamps ──────────────────────────────────────────────────
// new Date().toISOString() is UTC; the model reads this as "now", so it needs
// an explicit local-time offset, computed from the system timezone so the
// app is correct wherever the user runs it.
export function localISO(ms = Date.now()) {
  const d = new Date(ms)
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? '+' : '-'
  const abs = Math.abs(offMin)
  const hh = String(Math.trunc(abs / 60)).padStart(2, '0')
  const mm = String(abs % 60).padStart(2, '0')
  return new Date(ms + offMin * 60_000).toISOString().replace('Z', `${sign}${hh}:${mm}`)
}

function localWeekday(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(ms))
}

export const localNow = () => `${localISO()} (${localWeekday()})`

// ── agent config (.agent-config, the shell KEY="value" file the supervisor parses) ─
// Read on demand, never cached by callers that gate spending: the settings
// page can flip consent or a cap at any moment.
export async function readAgentConfig(dataHome) {
  const out = {}
  let text
  try {
    text = await fs.readFile(path.join(dataHome, '.agent-config'), 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

// ── stale atomic-write tmp sweep ───────────────────────────────────────────
// atomicWriteJson's tmp+rename leaves `<name>.<pid>.<ts>.tmp` behind when the
// process dies between writeFile and rename — a hard kill or OS reboot
// landing inside any write window. The liveness heartbeat writes every 60s,
// so that window recurs constantly, and the orphans accumulate forever
// (the Windows box 2026-08-18: three .agent-live.*.tmp from prior unclean
// shutdowns). Swept at backend boot (createMarkerStore — every transport
// builds one) rather than per-write: one directory scan per boot.
// Age gate (1h) protects a concurrent process's in-flight write; matching is
// pinned to the exact atomicWriteJson shape so user files are untouchable.
const STALE_TMP_RE = /\.\d+\.\d+\.tmp$/
const STALE_TMP_MAX_AGE_MS = 60 * 60 * 1000
export async function sweepStaleAtomicTmp(dataHome, log = () => {}) {
  let names = []
  try {
    names = await fs.readdir(dataHome)
  } catch {
    return 0 // no dataHome yet — nothing to sweep
  }
  let swept = 0
  for (const name of names) {
    if (!STALE_TMP_RE.test(name)) continue
    const p = path.join(dataHome, name)
    try {
      const st = await fs.stat(p)
      if (!st.isFile() || Date.now() - st.mtimeMs < STALE_TMP_MAX_AGE_MS) continue
      await fs.unlink(p)
      swept++
    } catch {} // raced away or unreadable — never boot-blocking
  }
  if (swept) log(`boot sweep: removed ${swept} stale atomic-write tmp file(s)`)
  return swept
}

// ── liveness + failure markers ─────────────────────────────────────────────
// ONE base schema for every backend, poller-facing field names fixed:
//   liveness  DATA_HOME/.agent-live         {status:'live', lastHeartbeat, pid}
//   failure   DATA_HOME/.agent-failed.json  {status:'failed', reason, code, since, pid}
// main.cjs's pollFailureMarker() and http-server.cjs's liveness check read
// exactly these files/fields regardless of which transport wrote them.
// Backends may extend a failure marker ONLY under `ext: {...}` — never with
// top-level fields, so the base schema cannot drift per transport.
// `code` defaults to 'unknown' so a call site can never silently emit a
// marker with no cause at all.
export function createMarkerStore({ dataHome }) {
  const LIVENESS_MARKER_PATH = path.join(dataHome, '.agent-live')
  const FAILURE_MARKER_PATH = path.join(dataHome, '.agent-failed.json')
  // http-server.cjs's LIVENESS_FRESH_MS (150s) tolerates one missed beat.
  const LIVENESS_HEARTBEAT_MS = 60_000

  async function writeLiveness() {
    await atomicWriteJson(LIVENESS_MARKER_PATH, { status: 'live', lastHeartbeat: new Date().toISOString(), pid: process.pid })
  }

  async function writeFailure(reason, code = 'unknown', ext = undefined) {
    const payload = { status: 'failed', reason, code, since: new Date().toISOString(), pid: process.pid }
    if (ext && Object.keys(ext).length) payload.ext = ext
    await atomicWriteJson(FAILURE_MARKER_PATH, payload)
  }

  return { LIVENESS_MARKER_PATH, FAILURE_MARKER_PATH, LIVENESS_HEARTBEAT_MS, writeLiveness, writeFailure }
}

// ── persisted last-conversation channel ────────────────────────────────────
// In-memory tracking dies with the process, but the boot announce runs
// BEFORE any inbound message of the new session — and a DM-only install has
// no reachable home channel at all. This file is the cross-restart memory of
// where the conversation lives. Write-on-change only; read at announce time.
export function createLastChannelStore({ dataHome, log = console.log }) {
  const LAST_CHANNEL_PATH = path.join(dataHome, '.last-channel')
  let persistedId = null

  function persist(channelId) {
    if (!channelId || channelId === persistedId) return
    persistedId = channelId
    fs.writeFile(LAST_CHANNEL_PATH, channelId).catch((err) => log(`last-channel persist failed: ${err.message}`))
  }

  async function load() {
    try {
      return (await fs.readFile(LAST_CHANNEL_PATH, 'utf8')).trim()
    } catch {
      return null
    }
  }

  return { LAST_CHANNEL_PATH, persist, load }
}

// ── outbound target resolution ─────────────────────────────────────────────
// The anti-confabulation ladder, one copy for all transports:
//   explicit id  -> honored exactly, or FAIL CLOSED (OUTBOUND_TARGET_INVALID):
//                   an unreachable explicit id throws rather than being
//                   silently rerouted — delivering to a channel nobody asked
//                   for is unrecoverable, while a message that never sent is
//                   recoverable and reported. The fallback is never consulted.
//   omitted id   -> lastInbound || home, throwing loudly when neither exists.
// resolve() returns {target, note}: target is the backend-native handle
// (Discord channel object / Slack channel id string / Telegram chat object).
// opts (fetchFn/lastId/homeId) are test seams — production call sites pass
// only requestedId and get live module state + the real fetch.
// ── Outbound duplicate suppression (2026-08-04, the owner field report) ─────────
// GPT-lane models (gpt-5.6-luna/terra via the codex-as-api proxy) were
// observed re-sending the IDENTICAL message up to ~10x -- the model ignores
// or never properly sees the tool result's "sent" receipt and re-calls the
// send tool, sometimes across turns ("멈추라고 해도 10번씩 보냄"). Claude
// lanes never did this, which points at the proxy's tool-result round-trip,
// but the proxy is an upstream package -- so the harness enforces sanity at
// the channel seam instead: an identical (channel, text) within windowMs is
// NOT posted again, and the tool result says so explicitly. That receipt is
// the loop-breaker: the model gets told, in words, that the message is
// already delivered and must not be re-sent.
//
// Deliberately EXACT-match on normalized text (whitespace collapsed): a
// legitimately repeated short ack within the window is rare, and when the
// agent truly means to repeat itself it can (and should) vary the wording --
// the receipt says exactly that. Map is pruned on every call, so it never
// grows beyond the traffic of one window.
export function createOutboundDedup({ windowMs = 60_000, log = console.log, now = Date.now } = {}) {
  const recent = new Map() // `${channelId}\0${normalizedText}` -> last-sent ms
  return function checkOutbound(channelId, text) {
    const t = now()
    for (const [k, ts] of recent) {
      if (t - ts > windowMs) recent.delete(k)
    }
    const key = `${channelId}\u0000${String(text).replace(/\s+/g, ' ').trim()}`
    const prev = recent.get(key)
    if (prev !== undefined) {
      const secs = Math.max(1, Math.round((t - prev) / 1000))
      log(`[outbound-dedup] suppressed identical message to ${channelId} (${secs}s after the previous send)`)
      return {
        duplicate: true,
        receipt:
          `DUPLICATE SUPPRESSED -- NOT sent again. You already sent this exact message to ${channelId} ${secs}s ago and it WAS delivered. ` +
          'Do NOT retry it. If you have something new to say, send a differently-worded message.',
      }
    }
    // NOT recorded here. Recording the key before the send poisons the dedup on
    // a FAILED send: the caller's target.send() can throw (transport 5xx /
    // rate-limit, or a multi-chunk reply where chunk 1 sent but chunk 2 threw),
    // the model naturally retries the identical text, and the retry gets
    // suppressed with a receipt that says "it WAS delivered -- do NOT retry" for
    // a message that never landed. Silent user-facing loss plus a lying receipt,
    // across all three transports. The key is committed ONLY after the caller
    // confirms a successful send, via commit(). A throw between here and commit()
    // therefore leaves the retry path open, which is the correct behaviour.
    return {
      duplicate: false,
      commit: () => { recent.set(key, now()) },
    }
  }
}

export function createOutboundResolver({ fetchTarget, getLastInboundId, homeId, guidance }) {
  return async function resolve(requestedId, opts = {}) {
    const fetchFn = opts.fetchFn || fetchTarget
    const lastId = 'lastId' in opts ? opts.lastId : getLastInboundId()
    const home = 'homeId' in opts ? opts.homeId : homeId
    const fallbackId = lastId || home || null
    if (requestedId) {
      try {
        return { target: await fetchFn(requestedId), note: null }
      } catch (err) {
        const e = new Error(
          `channelId ${requestedId} could not be resolved (${err.message}). Nothing was sent. ${guidance}`
        )
        e.code = 'OUTBOUND_TARGET_INVALID'
        throw e
      }
    }
    if (!fallbackId) throw new Error('no channelId given and no current conversation channel known yet')
    return { target: await fetchFn(fallbackId), note: null }
  }
}

// ── boot announcement ──────────────────────────────────────────────────────
// Detection is the harness's job, deterministically — a model asked to
// announce its own boot forgets sometimes, and outside the window silence is
// indistinguishable from death. Two-part unit, shared by every transport:
//   1. a direct system line (the one non-model-mediated send — liveness must
//      not depend on the model choosing to speak), then
//   2. a [SYSTEM] turn asking for a greeting in the agent's voice. No
//      "답장하지 마", so stop-reply-guard ENFORCES that the greeting lands.
// The .boot-event.json marker is written by the supervisor before each leaf
// spawn and consumed (unlinked) FIRST so no path can double-announce.
// .boot-announce-ts.json is the cross-restart throttle; the decision rule
// lives in cadence/boot-announce.cjs (pure, tested). The announce is one
// unit: direct line -> ts advance -> greeting inject. ts advances only after
// the direct send actually LANDS (spam requires successful sends, and a
// Discord/Slack/Telegram outage at boot must not burn the slot); if the
// direct send fails the whole unit aborts and the next restart retries.
//
// Transport adapter:
//   fetchTarget(id) -> announce handle, throws if unreachable
//   idOf(target)    -> string id stamped into the greeting inject's meta
//   sendText(target, text)
//   notify(params)  -> mcp.notification({method:'notifications/claude/channel', params})
//   noun            -> 'channel' | 'chat', transport wording in log lines
export function createBootAnnouncer({ dataHome, homeId, lastChannelStore, fetchTarget, idOf, sendText, notify, log, noun = 'channel' }) {
  const BOOT_EVENT_PATH = path.join(dataHome, '.boot-event.json')
  const BOOT_ANNOUNCE_TS_PATH = path.join(dataHome, '.boot-announce-ts.json')

  return async function announceBoot() {
    let ev = null
    try {
      ev = JSON.parse(await fs.readFile(BOOT_EVENT_PATH, 'utf8'))
    } catch {
      return // no marker: manual dev run, or the supervisor never wrote one
    }
    await fs.unlink(BOOT_EVENT_PATH).catch(() => {})

    const bootTick = require(path.join(MODULE_DIR, 'cadence', 'boot-announce.cjs'))
    const config = await readAgentConfig(dataHome)
    let lastAnnounceMs = 0
    try {
      lastAnnounceMs = JSON.parse(await fs.readFile(BOOT_ANNOUNCE_TS_PATH, 'utf8')).lastAnnounceMs || 0
    } catch {} // never announced (or unreadable): fail toward announcing once, not toward silence

    const plan = bootTick.planBootAnnounce({ now: Date.now(), event: ev, lastAnnounceMs, config })
    if (plan.skip) {
      log(`boot announce skipped (${plan.reason})`)
      return
    }

    // HOME first, then the persisted last conversation channel.
    let target = null
    let lastId = null
    try {
      target = await fetchTarget(homeId)
    } catch (homeErr) {
      lastId = await lastChannelStore.load()
      if (lastId && lastId !== homeId) {
        try {
          target = await fetchTarget(lastId)
          log(`boot announce: home ${noun} unreachable (${homeErr.message}), using persisted last ${noun} ${lastId}`)
        } catch {}
      }
      if (!target) {
        log(`boot announce: no reachable ${noun} (home: ${homeErr.message}; persisted last: ${lastId || 'none'}) -- aborting unit, next restart retries`)
        return
      }
    }
    try {
      await sendText(target, `🔁 [system] 에이전트 세션 ${plan.label} — ${localNow()}`)
    } catch (err) {
      log(`boot announce direct send failed -- aborting this announce unit, next restart retries: ${err.message}`)
      return
    }
    await atomicWriteJson(BOOT_ANNOUNCE_TS_PATH, { lastAnnounceMs: plan.nextLastAnnounceMs }).catch((err) =>
      log(`boot-announce ts write failed (worst case one extra ping next restart): ${err.message}`)
    )
    try {
      await notify({
        content:
          `[SYSTEM] 방금 세션이 ${plan.iteration > 1 ? '재시작됐다 (오늘 이 감독 아래 ' + plan.iteration + '번째)' : '시작됐다'}. ` +
          '방금 그 채널에 네 목소리로 짧게 부팅 인사를 남겨라 -- 살아있다는 신호가 목적이니 한두 문장이면 된다. ' +
          '체크포인트에 이어받을 일이 있으면 뭘 이어가는지 한 줄 붙여. ' +
          '그리고 이 세션 내내 지킬 것: 작업 블록에 들어가기 전에 "뭘 시작한다 + 어느 정도 걸릴 것 같다"를 먼저 한 줄로 알리고 시작해라.',
        // channelId = where the direct line actually LANDED, not a hardcoded
        // HOME: with home deleted, pointing the model at a dead channel would
        // make its guard-enforced greeting reply fail too.
        meta: { sender: 'SYSTEM', channelId: idOf(target), authorId: '', timestamp: localNow() },
      })
    } catch (err) {
      log(`boot greeting inject failed (direct line already sent): ${err.message}`)
    }
  }
}

// ── routines: user-requested scheduled prompts ─────────────────────────────
// "매일 아침 메일 브리핑해줘" -> the agent registers a routine with the
// `routine` tool -> the channel process fires the prompt back into the agent
// at the scheduled time, and the result lands in the conversation like any
// other turn (the owner, 2026-08-04).
//
// DELIBERATELY NOT the autonomy cycle: that lane is unattended night work
// behind its own consent gate (AUTONOMY=yes). A routine is something the
// user asked for out loud, in conversation, per item -- the consent IS the
// request. The two must not share a switch (cycle.cjs's consent-laundering
// note is the same principle in the other direction).
//
// FIRING IS AT-MOST-ONCE PER LOCAL DAY, and only while a channel process is
// running: markFired lands BEFORE the inject, so a crash mid-fire skips that
// day rather than double-spending; an app closed across the scheduled time
// fires LATE (same day, lateMinutes attached) rather than never, and an app
// closed past midnight misses that day honestly. No catch-up queue -- a
// Monday briefing delivered Thursday is noise wearing punctuality's clothes.

function routineParseHM(s) {
  if (typeof s !== 'string') return null
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1]); const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}

function routineLocalDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const ROUTINE_DAY_WORDS = { daily: [0, 1, 2, 3, 4, 5, 6], weekdays: [1, 2, 3, 4, 5], weekends: [0, 6] }

function routineNormalizeDays(days) {
  if (typeof days === 'string' && ROUTINE_DAY_WORDS[days]) return ROUTINE_DAY_WORDS[days]
  if (Array.isArray(days) && days.length && days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
    return [...new Set(days)].sort()
  }
  return null
}

export function createRoutineStore({ dataHome, log = console.log }) {
  const file = path.join(dataHome, 'routines.json')
  let routines = null // lazy; null = not yet loaded

  async function load() {
    if (routines) return routines
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8'))
      routines = Array.isArray(raw.routines)
        ? raw.routines.filter((r) => r && typeof r.id === 'string' && routineParseHM(r.time) !== null &&
            routineNormalizeDays(r.days) && typeof r.prompt === 'string' && r.prompt.trim())
        : []
    } catch {
      routines = [] // first run or corrupt: empty list beats a dead channel
    }
    return routines
  }

  async function persist() {
    await fs.mkdir(dataHome, { recursive: true })
    await atomicWriteJson(file, { routines })
  }

  async function add({ time, days, prompt }) {
    await load()
    if (routineParseHM(time) === null) throw new Error(`time must be "HH:MM" (24h), got ${JSON.stringify(time)}`)
    const normDays = routineNormalizeDays(days)
    if (!normDays) throw new Error('days must be "daily", "weekdays", "weekends", or an array of weekday numbers (0=Sun..6=Sat)')
    const text = String(prompt || '').trim()
    if (!text) throw new Error('prompt is required')
    if (text.length > 2000) throw new Error('prompt too long (2000 chars max)')
    const id = `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const routine = { id, time: time.trim(), days: normDays, prompt: text, createdAt: new Date().toISOString(), lastFiredDay: null }
    routines.push(routine)
    await persist()
    return routine
  }

  async function list() { return [...await load()] }

  async function remove(id) {
    await load()
    const before = routines.length
    routines = routines.filter((r) => r.id !== id)
    if (routines.length === before) return false
    await persist()
    return true
  }

  // Due = scheduled earlier today, today matches the day set, not yet fired
  // today. Late fires included by design (see header); lateMinutes tells the
  // agent how stale the trigger is so IT can decide what "morning briefing
  // at 15:00" should become.
  async function dueNow(now = new Date()) {
    await load()
    const today = routineLocalDay(now)
    const nowMin = now.getHours() * 60 + now.getMinutes()
    return routines
      .filter((r) => r.days.includes(now.getDay()) && routineParseHM(r.time) <= nowMin && r.lastFiredDay !== today)
      .map((r) => ({ ...r, lateMinutes: nowMin - routineParseHM(r.time) }))
  }

  async function markFired(id, now = new Date()) {
    await load()
    const r = routines.find((x) => x.id === id)
    if (!r) return
    r.lastFiredDay = routineLocalDay(now)
    await persist()
  }

  return { load, add, list, remove, dueNow, markFired, file }
}

// Tool surface, shared verbatim by every backend so the model sees ONE
// contract. The tool name rides the same frozen-name rule as reply/
// send_file_to_discord: allowlisted as an exact string.
export const ROUTINE_TOOL = {
  name: 'routine',
  description: 'Manage scheduled routines -- recurring prompts the user asked for ("매일 아침 메일 브리핑해줘"). action:"add" registers one (time + days + the prompt YOU should receive at that time, written as an instruction to yourself); "list" shows all; "remove" deletes by id. Routines fire only while the app is running: a missed day is skipped, a late start fires late with the delay noted.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'What to do' },
      time: { type: 'string', description: 'add: fire time as 24h "HH:MM" local' },
      days: { description: 'add: "daily", "weekdays", "weekends", or an array of weekday numbers (0=Sun..6=Sat)' },
      prompt: { type: 'string', description: 'add: the instruction to inject at fire time, e.g. "메일함을 확인하고 오늘 브리핑을 보내라"' },
      id: { type: 'string', description: 'remove: the routine id from list' },
    },
    required: ['action'],
  },
}

export async function handleRoutineTool(store, args) {
  const action = args && args.action
  try {
    if (action === 'add') {
      const r = await store.add({ time: args.time, days: args.days, prompt: args.prompt })
      return { content: [{ type: 'text', text: `routine added: ${r.id} at ${r.time} days=[${r.days}]\nIt fires only while the app is running.` }] }
    }
    if (action === 'list') {
      const all = await store.list()
      if (!all.length) return { content: [{ type: 'text', text: 'no routines registered' }] }
      return { content: [{ type: 'text', text: JSON.stringify(all, null, 1) }] }
    }
    if (action === 'remove') {
      const ok = await store.remove(String(args && args.id || ''))
      return ok
        ? { content: [{ type: 'text', text: 'removed' }] }
        : { content: [{ type: 'text', text: 'no routine with that id' }], isError: true }
    }
    return { content: [{ type: 'text', text: `unknown action: ${action}` }], isError: true }
  } catch (err) {
    return { content: [{ type: 'text', text: `routine ${action} failed: ${err.message}` }], isError: true }
  }
}

// One ticker per channel process. markFired BEFORE notify: at-most-once.
export function startRoutineTicker({ store, fire, log = console.log, intervalMs = 30_000, now = () => new Date() }) {
  const tick = async () => {
    try {
      const due = await store.dueNow(now())
      for (const r of due) {
        await store.markFired(r.id, now())
        try {
          await fire(r)
          log(`routine fired: ${r.id} (${r.lateMinutes}min late)`)
        } catch (err) {
          log(`routine fire failed for ${r.id} (skipped today, will retry tomorrow): ${err.message}`)
        }
      }
    } catch (err) {
      log(`routine tick failed: ${err.message}`)
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return { timer, tick } // tick exported for tests
}

// The line the agent receives at fire time -- shared so every backend
// injects the identical shape. [routine] prefix mirrors [reaction]'s role:
// a marker downstream consumers can match on.
export function routineInjectContent(r) {
  const late = r.lateMinutes > 5 ? ` (예정보다 ${r.lateMinutes}분 늦게 발화 -- 앱이 꺼져 있었다. 내용이 시효를 넘겼으면 그렇게 말하고 조정해라)` : ''
  return `[routine ${r.id}] 사용자가 등록한 루틴 시간이다${late}. 지시: ${r.prompt}`
}

// ── schedules: generic recurring/one-off prompts ────────────────────────────
// Replaces the pattern where every background behavior is its own bespoke
// setInterval: an entry in DATA_HOME/schedules.json IS a background
// behavior, authored by the user, the system (shipped defaults), or the
// agent itself (it may edit schedules.json directly -- its CLAUDE.md
// already gives it DATA_HOME write freedom; no new MCP tool for this).
// Inspired by Gemini Spark's Tasks/Schedules split.
//
// Rule lives in cadence/schedule-tick.cjs (pure, tested by
// tests/test-schedule-tick.mjs); THIS is only the IO, shared by every
// backend the same way startRoutineTicker is -- so a backend that forgets
// to call it is missing a wiring line, not missing an implementation.
//
// One difference from startRoutineTicker worth naming: this ticker guards
// against overlapping ticks (`inFlight`). Routines' own dueNow()/markFired()
// happen to be safe under overlap (markFired is idempotent-by-day); a
// schedule's write-back is a single read-modify-write of the whole store,
// which is not, so the guard is added rather than copied away.
export function startScheduleTicker({ dataHome, readConfig, fire, activityMsProvider = () => Infinity, log = console.log, intervalMs = 60_000, now = () => new Date() }) {
  const scheduleTick = require(path.join(MODULE_DIR, 'cadence', 'schedule-tick.cjs'))
  const storePath = path.join(dataHome, 'schedules.json')
  let inFlight = false

  // Absence-only seed of the one shipped default (Dreaming). The headless
  // lane also seeds via hooks/session-start.mjs; on the dsh lane Claude Code
  // hooks never run, so without THIS seed the default silently never
  // existed there (2026-08-19). Same tmp+rename convention as the hook --
  // a half-written store would fail every parse and kill every schedule.
  try {
    if (!fsSync.existsSync(storePath)) {
      const tmp = `${storePath}.tmp-${process.pid}`
      fsSync.writeFileSync(tmp, JSON.stringify(scheduleTick.defaultScheduleStore(), null, 2) + '\n')
      fsSync.renameSync(tmp, storePath)
      log('schedules: seeded default store (memory-consolidation, madoromi)')
    }
  } catch (err) {
    log(`schedules: default-store seed failed (non-fatal): ${err.message}`)
  }

  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      const config = await readConfig()
      let store = null
      try {
        store = JSON.parse(await fs.readFile(storePath, 'utf8'))
      } catch (err) {
        // Missing file (nothing registered yet) stays null -> silent in
        // schedule-tick.cjs. A file that EXISTS but won't parse is a fault
        // the user should hear about, so hand the planner a malformed
        // sentinel that trips its shape warning instead of the silent path.
        if (err && err.code !== 'ENOENT') store = { schedules: 'unparseable' }
      }

      const plan = scheduleTick.planScheduleTick({ now: now(), config, store, agentActiveMs: activityMsProvider() })

      for (const w of plan.warnings) log(`schedules: ${w}`)

      const fired = []
      for (const entry of plan.due) {
        try {
          await fire(entry)
          fired.push(entry.id)
          log(`schedules: fired ${entry.id}`)
        } catch (err) {
          // Not delivered -- do NOT mark lastRunISO. Next poll retries, same
          // "advance only on success" rule the shutdown/note-cadence
          // watchers already pay for elsewhere in this codebase.
          log(`schedules: fire failed for ${entry.id} (will retry next poll): ${err.message}`)
        }
      }

      if (fired.length) {
        // store is guaranteed non-null here: plan.due can only be non-empty
        // when planScheduleTick was handed a real { schedules: [...] } array.
        const nowISO = new Date().toISOString()
        for (const raw of store.schedules) {
          if (fired.includes(raw.id)) raw.lastRunISO = nowISO
        }
        await atomicWriteJson(storePath, store) // tmp+rename, same convention as .autonomy-state.json
      }
    } catch (err) {
      log(`schedule tick failed: ${err.message}`)
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return { timer, tick } // tick exported for tests
}

// The line the agent receives at fire time -- shared so every backend
// injects the identical shape, mirroring routineInjectContent's role.
export function scheduleInjectContent(entry) {
  // Not [SYSTEM]: the prompt is user-authored, and labeling it as system
  // authority lets a scheduled prompt assert privileges the user does not have.
  return `[SCHEDULED TASK] (user-authored) "${entry.id}": ${entry.prompt}`
}

// ── inbound notifier (design-0020, headless topology) ──────────────────────
// One seam for how a backend delivers an inbound message to the agent.
// Two lanes exist because two topologies exist:
//
//   headless (spawn, the default): headless-lane.mjs owns claude -p's stdin
//     and serves a loopback ingest endpoint; its {port, token} live in
//     DATA_HOME/.ingest-endpoint.json (0600, rewritten every lane boot).
//     The MCP notification is DEAD in -p mode (design-0020 probe 5), so
//     when that file exists and answers, POST /inbound is the only lane
//     that actually reaches the model.
//
//   attach (external tmux, interactive claude): no lane process, no
//     endpoint file -- the dev-channels MCP notification still works there
//     and remains the fallback.
//
// Resolution order per CALL, not per boot: the endpoint file is re-read
// every time (cheap: one small read) so a backend that outlives an agent
// recycle follows the lane's NEW port/token without a restart. If the file
// exists but the POST fails (dead port after a crash, mid-restart window),
// this THROWS after attempting the MCP fallback -- backends already treat a
// failed notify as "retry on next poll" (channel.mjs / telegram pollOnce),
// which is exactly the right behavior while the lane respawns.
export function createInboundNotifier({ dataHome, mcpNotify, log = console.log, fetchFn = fetch }) {
  const endpointPath = path.join(dataHome, '.ingest-endpoint.json')

  async function postToLane(params) {
    let ep
    try {
      ep = JSON.parse(await fs.readFile(endpointPath, 'utf8'))
    } catch {
      return false // no endpoint file -> not the headless topology (or lane not up yet)
    }
    if (!ep || !ep.port || !ep.token) return false
    // Liveness gate (red-team 2026-08-04 #2 / UX F5): the lane unlinks this
    // file on exit, but SIGKILL / power loss skips that handler and the stale
    // file would poison the ATTACH topology forever (POST fails -> throw ->
    // no MCP fallback -> every message "fails" even though the interactive
    // session would receive the notification fine). The endpoint file carries
    // the lane's pid; if that pid is gone, treat the file as absent and take
    // the MCP-fallback branch. A LIVE-but-hiccuping lane still throws below,
    // which is the correct no-black-hole behavior for headless.
    if (ep.pid) {
      try { process.kill(ep.pid, 0) } catch { return false }
    }
    const res = await fetchFn(`http://127.0.0.1:${ep.port}/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': ep.token },
      body: JSON.stringify(params),
    })
    if (!res.ok) throw new Error(`ingest POST failed: HTTP ${res.status}`)
    return true
  }

  return async function notifyInbound(params) {
    try {
      if (await postToLane(params)) return
    } catch (err) {
      // Endpoint file existed AND its pid is alive, but the POST failed:
      // headless topology mid-hiccup. Do NOT silently fall back to the MCP
      // notification -- in -p mode it is a black hole that would swallow the
      // message while looking delivered. Throw so the CALLER decides what
      // failure looks like. NOTE the retry reality per backend: telegram
      // genuinely redelivers (offset not advanced); discord (push) and slack
      // (acks before delivery) do NOT -- their MessageCreate/event handlers
      // must catch this and surface a user-visible failure receipt.
      log(`[inbound-notifier] lane POST failed, message NOT delivered: ${err.message}`)
      throw err
    }
    await mcpNotify(params)
  }
}

// ── mute-strike announcer ──────────────────────────────────────────────────
// The messenger-side half of the mute net (2026-08-13, the owner field case: kimi
// turn ends success turns=5 dur=765s, no reply ever reaches the messenger,
// "계속 답 못받는중"). stop-reply-guard already convicts the mute and writes
// the .mute-strikes.json ledger, and the PANEL shows a banner + revert offer
// (http-server /api/agent/mute-status) -- but the user lives in the
// messenger, where a mute looks identical to being ignored. Same species as
// createBootAnnouncer's direct line: visibility of a failing model must not
// be mediated by that model. The backend watches the ledger and posts a
// plain system line to the current conversation channel when strikes RISE.
//
// Baseline semantics: on start(), the current count is the baseline -- old
// strikes are panel history, not news; only a rise AFTER the watcher is
// alive announces. A drop (guard reset on a delivered reply, or the UI's
// clear) just lowers the baseline silently. Every send failure is swallowed
// into a log line: an announcer that can crash a backend over a strike
// notice is worse than the mute it reports.
//
// Target ladder mirrors the omitted-id outbound rule (lastInbound || last
// persisted channel || home) -- resolved at ANNOUNCE time, not start time,
// so the notice lands where the conversation actually is.
export function createMuteStrikeAnnouncer({ dataHome, homeId, lastChannelStore, getLastInboundId, fetchTarget, sendText, log = console.log, pollMs = 5_000 }) {
  const STRIKES_PATH = path.join(dataHome, '.mute-strikes.json')
  let baseline = null
  let timer = null

  async function readCount() {
    try {
      const v = JSON.parse(await fs.readFile(STRIKES_PATH, 'utf8'))
      const n = Number(v && v.strikes)
      return Number.isFinite(n) && n >= 0 ? n : 0
    } catch {
      return 0 // absent/unreadable ledger = no strikes (guard's own contract)
    }
  }

  async function announce(count) {
    const targetId = (getLastInboundId && getLastInboundId()) || (lastChannelStore && await lastChannelStore.load()) || homeId
    if (!targetId) throw new Error('no channel to announce to (no inbound yet, no persisted channel, no home)')
    const target = await fetchTarget(targetId)
    // Copy is strike-count-aware: the panel's one-click revert banner only
    // exists from MUTE_STRIKE_THRESHOLD (2) onward -- promising a button
    // that is not there yet would be its own small silent-death.
    const fix = count >= 2
      ? '앱 패널을 열면 상단에 이전 모델로 되돌리는 원클릭 버튼이 떠 있어. Settings > Model에서 직접 바꿔도 되고.'
      : '한 번 더 반복되면 앱 패널에 이전 모델로 되돌리는 원클릭 버튼이 떠. 지금 바꾸려면 Settings > Model에서.'
    await sendText(target,
      `⚠️ 방금 턴에서 답장이 만들어지고도 전송되지 않았어 (뮤트 감지 ${count}회차). ` +
      `모델이 메시지 도구 호출에 실패하고 있어 — ${fix} 상세 로그는 패널 Logs에.`)
  }

  async function tick() {
    let count
    try { count = await readCount() } catch { return }
    if (baseline === null) { baseline = count; return } // first tick after a pre-start write race
    if (count > baseline) {
      try {
        await announce(count)
        log(`[mute-announcer] strike ${baseline} -> ${count} announced to the conversation channel`)
      } catch (err) {
        log(`[mute-announcer] strike ${baseline} -> ${count} but the notice could not be sent: ${err.message}`)
      }
    }
    baseline = count // rise announced (or send failed -- do not spam-retry a broken transport); drop = silent rebase
  }

  return {
    async start() {
      baseline = await readCount()
      timer = setInterval(() => { tick() }, pollMs)
      if (timer.unref) timer.unref()
    },
    stop() { if (timer) clearInterval(timer); timer = null },
    _tick: tick, // test seam
  }
}
