#!/usr/bin/env node
// test-pending-signal.mjs -- the pending signal ("!", design-0024), over the
// REAL onboarding server against the REAL channel HTTP surface.
//
// What this file proves that reading the route cannot:
//   - the route group is actually registered and reaches its handlers through
//     the live server (the API_ROUTES line, not the module);
//   - the three sources count from real on-disk state, and a block that is not
//     PENDING neither counts nor gets quoted;
//   - the stamp is real: the same pile does not light again, a pile that grew
//     does;
//   - every unreadable source contributes 0 and nothing answers 500 -- and, on
//     a fresh install, asking the question does not CREATE the memory db;
//   - the click injects exactly one turn through channel-local.mjs's own
//     /system-turn, with meta.sender 'SYSTEM' on the home channel, no
//     "답장하지 마" in the text, and nothing added to the transcript;
//   - nothing periodic is wired to this route (no timer in the module, no
//     mention of the path in any schedule-capable file).
//
// The channel side is the REAL createRequestHandler from channel-local.mjs --
// not a hand-rolled stub -- so the meta shape asserted below is the shape the
// channel actually builds, and the transcript assertion reads the channel's
// own /out.
//
// Hermetic: env before import, same discipline as tests/test-chat-proxy.mjs.
//
// Run: node tests/test-pending-signal.mjs

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-pending-'))

const fixtureHome = path.join(tmp, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
// USERPROFILE too, or this is not hermetic on Windows (os.homedir() ignores
// HOME there) -- same note as tests/test-memory-routes-e2e.mjs.
process.env.USERPROFILE = fixtureHome
process.env.AGENT_DATA_HOME = path.join(tmp, 'data')
fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
process.env.AGENT_NAME = 'pending-signal-test'

const DATA_HOME = process.env.AGENT_DATA_HOME
const DB_PATH = process.env.SCHEHERAZADE_MEMORY_DB

// Everything above runs before ANY import: http-server reads AGENT_DATA_HOME
// and memory/service.mjs reads SCHEHERAZADE_MEMORY_DB at module load, once.
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer, SERVER_TOKEN } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
// Same URL shape http-server's own dynamic import uses, so this is the SAME
// module instance (and the same singleton connection) the route runs on.
const service = await import(pathToFileURL(path.join(ROOT, 'memory', 'service.mjs')).href)
// The module under test on the channel side. Importing it is safe and is its
// own test's idiom (tests/test-local-channel.mjs): the isMainModule guard means
// no stdio transport is connected and no port is bound.
const { createRequestHandler, LOCAL_CHANNEL_ID } = await import(pathToFileURL(path.join(ROOT, 'channel-local.mjs')).href)

let pass = 0
let fail = 0
const chk = (n, c, d) => {
  if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) }
}

// ── the channel side: the real handler, a recording replace for notify ─────
// `received` holds what the channel handed to notifyInbound (the same call the
// boot greeting makes): one entry per injected turn.
const CHANNEL_TOKEN = 'c'.repeat(64)
const received = []
const channelHandler = createRequestHandler({
  token: CHANNEL_TOKEN,
  notify: (n) => { received.push(n) },
})
const channelSrv = http.createServer((req, res) => { channelHandler(req, res) })
await new Promise((r) => channelSrv.listen(0, '127.0.0.1', r))
const channelPort = channelSrv.address().port

const portFile = path.join(DATA_HOME, 'local-channel.json')
fs.writeFileSync(portFile, JSON.stringify({ port: channelPort, token: CHANNEL_TOKEN }))

const srv = await createOnboardingServer()
const port = srv.server.address().port
const base = `http://127.0.0.1:${port}`
const auth = { 'x-onboard-token': SERVER_TOKEN }

const getPending = async () => {
  const r = await fetch(`${base}/api/pending-signal`, { headers: auth })
  return { status: r.status, body: await r.json() }
}
const recite = async () => {
  const r = await fetch(`${base}/api/pending-signal/recite`, { method: 'POST', headers: auth, body: '{}' })
  return { status: r.status, body: await r.json() }
}
const channelOut = async () => {
  const r = await fetch(`http://127.0.0.1:${channelPort}/out?since=0`, { headers: { authorization: `Bearer ${CHANNEL_TOKEN}` } })
  return r.json()
}

try {
  // ── (1) fresh install: nothing piled, and NOTHING is created ─────────────
  // The common case must not produce a phantom "!" -- and the reader must not
  // grow a memory.db just because the chat header asked (service.query() runs
  // ensureDb(), which opens the file and runs the DDL).
  {
    const g = await getPending()
    chk('fresh install: 200 { ok:true, total:0 }',
      g.status === 200 && g.body.ok === true && g.body.total === 0, JSON.stringify(g.body))
    chk('fresh install: every source is 0, none missing from the shape',
      g.body.sources && g.body.sources.corrections === 0 && g.body.sources.reflux === 0 && g.body.sources.dreams === 0,
      JSON.stringify(g.body.sources))
    chk('the reader did NOT create memory.db (no phantom database on a fresh install)',
      !fs.existsSync(DB_PATH), DB_PATH)
    const r = await recite()
    chk('fresh install: recite answers injected:false reason:empty',
      r.status === 200 && r.body.ok === true && r.body.injected === false && r.body.total === 0 && r.body.reason === 'empty',
      JSON.stringify(r.body))
    chk('...and nothing at all was injected at the channel', received.length === 0)
  }

  // ── (2) the three readers, from real state ───────────────────────────────
  // dreams: counted as FILES (hooks/session-start.mjs:79's count), so one
  // file is 1 however many entries it holds.
  fs.mkdirSync(path.join(DATA_HOME, 'dreams'), { recursive: true })
  fs.writeFileSync(path.join(DATA_HOME, 'dreams', '2026-09-20.md'), '# dreams\n\n## [03:10] -- madoromi\n\n물소리.\n')
  {
    const g = await getPending()
    chk('one dream file counts 1', g.body.sources.dreams === 1 && g.body.total === 1, JSON.stringify(g.body))
  }

  // reflux: one proposal per `---`-delimited block, PENDING only.
  const PENDING_LINE = '존댓말 대신 반말로 답하기'
  const APPROVED_LINE = 'APPROVED-BLOCK-NEVER-QUOTED'
  fs.mkdirSync(path.join(DATA_HOME, '.review'), { recursive: true })
  fs.writeFileSync(path.join(DATA_HOME, '.review', 'reflux-proposals.md'), [
    '# Persona Reflux Proposals',
    '',
    '---',
    '**Date**: 2026-09-19',
    '**Source**: session_notes/2026-09-19.md:4',
    `**Correction**: ${PENDING_LINE}`,
    '**Proposed self_persona change**: (agent fills in on review)',
    '**Status**: PENDING',
    '',
    '---',
    '**Date**: 2026-09-18',
    '**Source**: session_notes/2026-09-18.md:9',
    `**Correction**: ${APPROVED_LINE}`,
    '**Proposed self_persona change**: done',
    '**Status**: APPROVED',
    '',
  ].join('\n'))
  {
    const g = await getPending()
    chk('one PENDING block counts 1 and the APPROVED block counts 0',
      g.body.sources.reflux === 1 && g.body.total === 2, JSON.stringify(g.body))
  }

  // corrections: the still_active count, seeded through the service API (the
  // same code path the memory routes use).
  const seeded = service.write({
    table: 'corrections',
    data: { what_was_wrong: 'tone', correct_behavior: '반말', corrected_session: 'sess-pending' },
  })
  chk('seed correction landed (service API)', seeded.mode === 'insert' && seeded.id > 0, JSON.stringify(seeded))
  {
    const g = await getPending()
    chk('one active correction counts 1 (total 3 across the three sources)',
      g.body.sources.corrections === 1 && g.body.total === 3, JSON.stringify(g.body))
    chk('sources is the pending breakdown and total is its sum',
      g.body.total === g.body.sources.corrections + g.body.sources.reflux + g.body.sources.dreams)
  }

  // ── (3) the click: one SYSTEM turn, no silence pattern, no transcript ────
  {
    received.length = 0
    const r = await recite()
    chk('recite answers injected:true, and total is now 0 (the stamp applied)',
      r.status === 200 && r.body.ok === true && r.body.injected === true && r.body.total === 0, JSON.stringify(r.body))
    chk('exactly one turn was injected', received.length === 1, String(received.length))
    const n = received[0]
    chk('the turn rides notifications/claude/channel',
      n && n.method === 'notifications/claude/channel', JSON.stringify(n && n.method))
    const meta = n && n.params && n.params.meta
    chk('meta.sender is SYSTEM', meta && meta.sender === 'SYSTEM', JSON.stringify(meta))
    chk('meta.channelId is the home channel, NOT the guard-exempt "system"',
      meta && meta.channelId === LOCAL_CHANNEL_ID && meta.channelId !== 'system', JSON.stringify(meta))
    chk('meta.authorId is empty (no human authored this)', meta && meta.authorId === '')
    // The boot greeting's own stamp: channel-runtime's localNow() is a
    // local-ISO instant with its offset PLUS a weekday trailer
    // ("2026-09-28T23:44:23.966+09:00 (Mon)"), so that is the shape pinned
    // here rather than a bare Date.parse-able ISO.
    const ts = meta && meta.timestamp
    chk('meta.timestamp is the boot greeting\'s own local-ISO stamp (offset + weekday)',
      typeof ts === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}:\d{2} \([A-Za-z]{3}\)$/.test(ts)
      && !Number.isNaN(Date.parse(ts.split(' (')[0])), JSON.stringify(ts))

    const content = n && n.params && n.params.content
    chk('content starts the lowercase [system] divider the page renders', typeof content === 'string' && content.startsWith('[system]'), String(content).slice(0, 60))
    // The guard's silence patterns (hooks/stop-reply-guard.mjs:119-120). Their
    // ABSENCE is what makes the guard force the utterance -- this is the
    // design's premise, so it is pinned here, not assumed.
    chk('content carries no silence pattern (no "답장하지 마" or its siblings)',
      !/답장\s*하지\s*마|대답\s*하지\s*마|대답하지마|생각만|조용|무시해|don'?t\s+reply|stay\s+silent/i.test(String(content)), String(content))
    chk('content names all three counts', /교정 1건/.test(content) && /환류 제안 1건/.test(content) && /꿈 조각 1개/.test(content), String(content))
    chk('content quotes the PENDING proposal line', content.includes(PENDING_LINE), String(content))
    chk('content never quotes a non-PENDING proposal', !content.includes(APPROVED_LINE), String(content))
    chk('content carries no ISO date (the divider label stays prose)',
      !/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(content)), String(content))

    // The recital is a message TO the agent: it must not become the user's own
    // half of the conversation (the /in rule).
    const out = await channelOut()
    chk('the recital added nothing to the transcript', Array.isArray(out.items) && out.items.length === 0, JSON.stringify(out.items))
  }

  // ── (4) the same pile does not light twice ───────────────────────────────
  {
    const g = await getPending()
    chk('after the recital the same pile is not pending (mark stays dark)',
      g.body.total === 0 && g.body.sources.corrections === 0 && g.body.sources.reflux === 0 && g.body.sources.dreams === 0,
      JSON.stringify(g.body))
    received.length = 0
    const r = await recite()
    chk('a second click on an un-grown pile injects nothing',
      r.body.injected === false && r.body.reason === 'empty' && received.length === 0, JSON.stringify(r.body))
  }

  // ── (5) a pile that GREW re-lights, per source ───────────────────────────
  {
    fs.writeFileSync(path.join(DATA_HOME, 'dreams', '2026-09-21.md'), '# dreams\n\n## [04:00] -- madoromi\n\n바람.\n')
    const g = await getPending()
    chk('one more dream file re-lights only the dreams source',
      g.body.sources.dreams === 1 && g.body.sources.corrections === 0 && g.body.sources.reflux === 0 && g.body.total === 1,
      JSON.stringify(g.body))
    const r = await recite()
    chk('the grown pile recites and settles again', r.body.injected === true && r.body.total === 0, JSON.stringify(r.body))

    // A second PENDING block moves the reflux source on its own.
    fs.appendFileSync(path.join(DATA_HOME, '.review', 'reflux-proposals.md'), [
      '---',
      '**Date**: 2026-09-20',
      '**Source**: session_notes/2026-09-20.md:2',
      '**Correction**: 두 번째 교정',
      '**Proposed self_persona change**: (agent fills in on review)',
      '**Status**: PENDING',
      '',
    ].join('\n'))
    const g2 = await getPending()
    chk('a new PENDING proposal re-lights the reflux source alone',
      g2.body.sources.reflux === 1 && g2.body.sources.dreams === 0 && g2.body.total === 1, JSON.stringify(g2.body))
  }

  // ── (5b) checkpoint lag + housekeeping lines (0.3.8, Mino 2026-09-29) ─────
  // A session note written after checkpoint.md (or with no checkpoint at all)
  // lights the checkpoint source; the recital then orders the rewrite and the
  // persona pass. Refreshing checkpoint.md settles it.
  {
    fs.mkdirSync(path.join(DATA_HOME, 'session_notes'), { recursive: true })
    fs.writeFileSync(path.join(DATA_HOME, 'session_notes', '2026-09-20.md'), '# note\n')
    const g = await getPending()
    chk('a session note with no checkpoint.md lights the checkpoint source',
      g.body.sources.checkpoint === 1, JSON.stringify(g.body))
    const before = received.length
    const r = await recite()
    chk('checkpoint lag recites', r.body.injected === true, JSON.stringify(r.body))
    const n = received[before]
    const content = String(n && n.params && n.params.content)
    chk('recital orders the checkpoint rewrite with the lag count',
      /세션노트 1개만큼 뒤처져/.test(content) && content.includes('checkpoint.md'), content)
    chk('recital carries the persona pass through the reflux procedure',
      content.includes('persona-reflux.md') && content.includes('self_persona.md'), content)
    const later = new Date(Date.now() + 60_000)
    fs.writeFileSync(path.join(DATA_HOME, 'checkpoint.md'), '# checkpoint\n')
    fs.utimesSync(path.join(DATA_HOME, 'checkpoint.md'), later, later)
    const g2 = await getPending()
    chk('a fresh checkpoint.md settles the checkpoint source',
      g2.body.sources.checkpoint === 0, JSON.stringify(g2.body))
    fs.rmSync(path.join(DATA_HOME, 'session_notes'), { recursive: true, force: true })
    fs.rmSync(path.join(DATA_HOME, 'checkpoint.md'), { force: true })
  }

  // ── (6) every unreadable source is 0, and never a 500 ────────────────────
  {
    fs.rmSync(path.join(DATA_HOME, '.review'), { recursive: true, force: true })
    const g = await getPending()
    chk('missing .review/: 200, reflux 0, no error page',
      g.status === 200 && g.body.ok === true && g.body.sources.reflux === 0 && g.body.total === 0, JSON.stringify(g.body))

    fs.rmSync(path.join(DATA_HOME, 'dreams'), { recursive: true, force: true })
    const g2 = await getPending()
    chk('missing dreams/: 200, dreams 0, no error page',
      g2.status === 200 && g2.body.sources.dreams === 0, JSON.stringify(g2.body))

    // Unreadable db: the file is there, the bytes are not a database. The
    // singleton must be closed first, or the route would read through the
    // handle this test still holds.
    service.close()
    fs.writeFileSync(DB_PATH, 'this is not a sqlite database, it is a sentence')
    const g3 = await getPending()
    chk('unreadable memory.db: 200, corrections 0, no error page',
      g3.status === 200 && g3.body.ok === true && g3.body.sources.corrections === 0 && g3.body.total === 0, JSON.stringify(g3.body))
    const r = await recite()
    chk('...and recite on an all-zero pile still answers empty, never 500',
      r.status === 200 && r.body.injected === false && r.body.reason === 'empty', JSON.stringify(r.body))
  }

  // ── (7) nothing periodic is wired to this ────────────────────────────────
  // The design's hardest line: the only thing that runs is what the click
  // starts. Two pins -- no schedule-capable file knows the route's path, and
  // the module itself holds no timer primitive.
  {
    const scanned = []
    const walk = (p) => {
      let st
      try { st = fs.statSync(p) } catch { return }
      if (st.isDirectory()) { for (const e of fs.readdirSync(p)) walk(path.join(p, e)); return }
      if (/\.(mjs|cjs|js|json)$/.test(p)) scanned.push(p)
    }
    for (const rel of ['cadence', 'autonomy', 'hooks', 'scripts', 'calendar']) walk(path.join(ROOT, rel))
    for (const rel of ['supervisor.mjs', 'main.cjs', 'channel.mjs', 'channel-local.mjs', 'channel-runtime.mjs', 'headless-lane.mjs', 'dsh-lane.mjs', 'attach-topology.cjs']) {
      scanned.push(path.join(ROOT, rel))
    }
    const hits = scanned.filter((f) => {
      try { return fs.readFileSync(f, 'utf8').includes('api/pending-signal') } catch { return false }
    })
    chk(`no schedule-capable file mentions the route (${scanned.length} files scanned)`, hits.length === 0, hits.join(', '))

    const routeSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'pending-signal.cjs'), 'utf8')
    chk('the route module holds no timer primitive (only a request runs it)',
      !/setInterval|setTimeout|node-cron|\.schedule\(/.test(routeSrc))
  }

  // ── (8) the frozen contract's gates ──────────────────────────────────────
  {
    const noTok = await fetch(`${base}/api/pending-signal/recite`, { method: 'POST', body: '{}' })
    chk('recite without the onboard token is refused (403, gate before route)', noTok.status === 403, noTok.status)
    const noTokGet = await fetch(`${base}/api/pending-signal`)
    chk('the GET is gated like every other /api read (403 without the token)', noTokGet.status === 403, noTokGet.status)
  }
} finally {
  srv.server.close()
  await new Promise((r) => channelSrv.close(r))
  try { service.close() } catch { /* already closed */ }
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
