// channel-runtime.mjs — protocol-neutral runtime layer shared by every
// channel backend (channel.mjs / channel-slack.mjs / channel-telegram.mjs).
//
// Zero transport imports, on purpose: everything here is about the MCP stdio
// contract, the DATA_HOME marker files, and the outbound-target ladder — none
// of which belongs to Discord, Slack, or Telegram. Backends keep only
// transport behavior: client/login, fetch-target and send implementations,
// message normalization, event wiring. scripts/test-channel-runtime.mjs is
// the tripwire that keeps it that way.
//
// resolveDataHome() MUST stay formula-identical to run.sh's MEM resolution
// (`MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"`): same env var,
// same fallback, keyed by AGENT_NAME. main.cjs / onboarding/http-server.cjs
// compute DATA_HOME independently and poll the marker files written here —
// a drifted formula makes the agent invisible to its own supervisor.
// (history: docs/HISTORY.md)

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

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
  return process.env.AGENT_DATA_HOME || path.join(os.homedir(), 'Documents', agentName)
}

// ── atomic JSON write (temp file + rename) ─────────────────────────────────
// Shared with run.sh's write_failure() convention: pollers read these files
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

// ── agent config (.agent-config, the shell KEY="value" file run.sh sources) ─
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
