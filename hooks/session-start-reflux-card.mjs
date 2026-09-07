#!/usr/bin/env node
// session-start-reflux-card.mjs — SessionStart hook.
// ADVISORY ONLY — never blocks a boot. Any internal error is fail-open
// (silent exit 0, no output), same posture as pre-reply-corrections-
// context.mjs, whose DB-access pattern this hook reuses verbatim (same
// DATA_HOME/DB_PATH resolution, same read-only DatabaseSync open, same
// existsSync guard before touching the db file at all).
//
// WHY THIS HOOK EXISTS (design doc R2, corrections -> self-description
// reflux): the `corrections` table + pre-reply-corrections-context.mjs
// already close the "don't repeat a taught mistake mid-conversation" loop.
// What's still missing is the higher-order step: if the SAME correction (or
// several) keeps recurring, that's no longer a one-off reminder, it's a
// candidate for promotion into how the agent describes itself. v1 stays
// advisory-only by design (design doc §principles + this pack's own
// precedent: automatic persona/self-description writes are OFF everywhere
// in this pack, e.g. scripts/persona-reflux.mjs never writes self_persona.md
// itself either) -- this hook only surfaces the count, judgment and
// authorship of any actual write stays with the agent.
//
// Threshold semantics (documented judgment call): design doc §R2 reads as a
// plain magnitude check ("still_active 교정이 N개 이상 쌓였으면"), not a
// delta since a prior extraction event -- so this hook queries the CURRENT
// count of still_active corrections on every boot and compares it against
// REFLUX_THRESHOLD directly. No separate persisted counter/state file is
// needed for that reading: the `corrections` table's own still_active flag
// already IS the accumulator, and it only comes back down when the agent
// (or a future consumer) resolves/deactivates a correction. Consequence:
// this card will keep appearing on every boot for as long as the active
// count stays at/above threshold -- intentional per the design doc (nothing
// there describes a snooze/decay), and bounded in practice by boot
// frequency rather than by every-reply frequency the way the corrections
// gate itself is.
//
// self_notes.md reference below is taken verbatim from the design doc's own
// wording ("니 자기 노트(MEM/self_notes.md)에 원칙으로 승격할지 판단해라").
// That file does not otherwise exist in this repo's convention today -- the
// repo's actual self-description file is self_persona.md, changed only
// through scripts/persona-reflux.mjs's separate 🔒-marker cycle (see
// CLAUDE.md §4). This hook does not create or touch either file; it is
// pure advisory text, so the mismatch has no functional effect here, but it
// is a real open question for PO sign-off (see file-end note / final
// report): should this point at self_persona.md's existing reflux path
// instead of a new self_notes.md concept?
//
// SNOOZE (red-team 2026-08-05 item 7, boot budget; DEVIATES from the "no
// snooze/decay" reading above, deliberately): re-printing the identical card
// on every boot for as long as the count sits at threshold is unbounded
// repeat injection, and a card that is always there stops being read at all.
// The card now re-appears only when the situation CHANGED (active count went
// up) or SNOOZE_MS elapsed. Snoozing hides a NUDGE, never a correction --
// the corrections themselves still ride every reply via
// pre-reply-corrections-context.mjs, which this does not touch.

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveDataHome } from '../data-home.cjs' // one resolver: AGENT_DATA_HOME || MEM || ~/Documents/Scheherazade

const HOOK = 'session-start-reflux-card'

// Named + env-overridable per task spec. SCHEHERAZADE_-prefixed to match
// this pack's existing override naming (SCHEHERAZADE_MEMORY_DB,
// SCHEHERAZADE_RUMINATION_GATE).
const DEFAULT_REFLUX_THRESHOLD = 3
const REFLUX_THRESHOLD = (() => {
  const raw = process.env.SCHEHERAZADE_REFLUX_THRESHOLD
  const n = raw != null ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_REFLUX_THRESHOLD
})()

// DATA_HOME / DB_PATH resolution mirrors pre-reply-corrections-context.mjs
// exactly, so this hook always reads the SAME database the memory MCP
// server writes to.
const DATA_HOME = resolveDataHome()
const DB_PATH = process.env.SCHEHERAZADE_MEMORY_DB || path.join(DATA_HOME, 'memory.db')
// Snooze state (see SNOOZE note in the header). Lives beside the rumination
// gate's markers, same .gates/ convention.
const SNOOZE_PATH = path.join(DATA_HOME, '.gates', 'reflux-card.json')
const DEFAULT_SNOOZE_HOURS = 12
const SNOOZE_MS = (() => {
  const raw = process.env.SCHEHERAZADE_REFLUX_SNOOZE_HOURS
  const n = raw != null ? Number.parseFloat(raw) : NaN
  return (Number.isFinite(n) && n >= 0 ? n : DEFAULT_SNOOZE_HOURS) * 3600 * 1000
})()

// ── PRODUCT COPY — PO 최종화 대기 ──────────────────────────────────────────
// 초안 원칙(설계 문서 §1-3): 존댓말, 이모지/느낌표 금지, "기능"으로 읽히는 톤.
const GATE_COPY = {
  header: (n) => `아직 반영되지 않은 교정이 ${n}건 쌓여 있습니다.`,
  body: '같은 교정이 반복되고 있다면, 자기 서술(self_persona.md)에 원칙으로 승격할지 판단해 주세요.', // PO 확정: 신규 파일 발명 대신 setup.sh가 부트스트랩하는 실존 파일로 (07-05 02:3x)
  footer: '자동으로 반영되지 않습니다. 판단과 집필은 직접 해 주세요.',
}

function succeedEmpty() {
  process.exit(0)
}

function succeedWithContext(ctx) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ctx,
      },
    }),
  )
  process.exit(0)
}

function failOpen(stage, err) {
  process.stderr.write(`[${HOOK}] WARN fail-open (${stage}): ${err && err.message ? err.message : err}\n`)
  process.exit(0)
}

try {
  // No stdin schema dependency here (unlike the PreToolUse hooks) -- a
  // SessionStart card does not need to branch on tool_name, so a missing/
  // malformed stdin body is not itself a reason to bail. Still read/parse
  // defensively since the hook protocol always sends *something* on stdin.
  try {
    readOptionalStdin()
  } catch (e) {
    failOpen('stdin read', e)
  }

  if (!existsSync(DB_PATH)) succeedEmpty() // no memory db yet (fresh install) -- nothing to count, not an error

  let count
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM corrections WHERE still_active = 1').get()
      count = row && typeof row.n === 'number' ? row.n : 0
    } finally {
      db.close()
    }
  } catch (e) {
    failOpen('db read', e)
  }

  if (!count || count < REFLUX_THRESHOLD) succeedEmpty()

  // Snooze check. Best-effort throughout: an unreadable/unwritable state
  // file must never suppress the card NOR crash the boot -- on any error the
  // card shows (fail-toward-visible, since the card is the safe outcome).
  let prev = null
  try {
    if (existsSync(SNOOZE_PATH)) prev = JSON.parse(readFileSync(SNOOZE_PATH, 'utf8'))
  } catch { prev = null }
  if (prev && typeof prev.count === 'number' && typeof prev.shownAt === 'number') {
    const escalated = count > prev.count // situation got worse -> speak again immediately
    const fresh = Date.now() - prev.shownAt < SNOOZE_MS
    if (!escalated && fresh) succeedEmpty()
  }
  try {
    mkdirSync(path.dirname(SNOOZE_PATH), { recursive: true })
    const tmp = `${SNOOZE_PATH}.tmp`
    writeFileSync(tmp, JSON.stringify({ count, shownAt: Date.now() }))
    renameSync(tmp, SNOOZE_PATH) // atomic: a torn state file reads as corrupt -> card shows
  } catch { /* best-effort: worst case the card repeats, which is the old behavior */ }

  const lines = [`[환류 카드] ${GATE_COPY.header(count)}`, '', GATE_COPY.body, '', GATE_COPY.footer]
  succeedWithContext(lines.join('\n'))
} catch (e) {
  failOpen('top-level', e)
}

// Reads and discards stdin without throwing on empty/absent input -- there
// is nothing in a SessionStart payload this hook branches on, but reading
// it keeps behavior consistent with the rest of the pack and avoids ever
// leaving stdin half-read.
function readOptionalStdin() {
  try {
    // fd 0, not '/dev/stdin': that path does not exist on Windows, so the read
    // threw, the catch exited 0, and this hook did NOTHING on that platform --
    // silently, which is the failure mode hooks are least able to report.
    // (Found 2026-08-04 running the suite on the win box.) readFileSync(0) is
    // the portable form and behaves identically on POSIX.
    readFileSync(0, 'utf8')
  } catch {
    // no stdin, or already consumed -- fine, nothing depends on the content
  }
}
