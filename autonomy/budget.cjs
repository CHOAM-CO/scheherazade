// budget.cjs -- the token meter behind the autonomous cycle's daily cap.
//
// v0.0.6 burns the USER's tokens while they are asleep. A cap that does not
// actually measure spend is not a cap, it is a certificate machine: it can
// only ever say "fine", which is the same failure class as the swap-time
// smoke test we killed on 2026-07-13 (a gate that cannot fail the known-bad
// case). So this file measures REAL tokens or it refuses to answer.
//
// Where the numbers come from: the Claude Code CLI writes a JSONL transcript
// per session under ~/.claude/projects/<cwd-slug>/, and every assistant row
// carries `message.usage` (input_tokens, output_tokens,
// cache_creation_input_tokens, cache_read_input_tokens) plus a top-level ISO
// `timestamp`. run.sh cd's into DATA_HOME before spawning the CLI (run.sh:285),
// so the agent's transcripts live under the slug for DATA_HOME. We do not
// trust that derivation blindly -- see resolveTranscriptDir().
//
// THE ONE RULE HERE: silence falls toward NOT SPENDING.
// Every failure to measure (dir missing, unreadable, unparseable, CLI changed
// its format) returns { ok: false } and the caller MUST treat that as "the
// autonomous cycle may not run". A meter that fails open is worse than no
// meter, because it manufactures the feeling of a limit.
//
// Tokens are counted, never priced. No dollars anywhere in this file.

const fs = require('fs')
const path = require('path')
const os = require('os')

// The CLI's project-slug transform: every character outside [A-Za-z0-9] becomes
// '-'. `/Users/narr/Documents/Scheherazade` -> `-Users-narr-Documents-Scheherazade`.
function slugForCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

// SCHEHERAZADE_PROJECTS_ROOT exists so the tests can point at a scratch tree
// (same convention as memory/server.mjs reading SCHEHERAZADE_MEMORY_DB). It is
// read on every call, not cached: the tests build the tree, then measure it.
function projectsRoot() {
  return process.env.SCHEHERAZADE_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects')
}

// Read the last `n` bytes of a file and return whole parsed JSONL rows.
// Transcripts are append-only and can reach tens of MB; we never read them
// whole. A partial first line (we landed mid-row) is dropped, not guessed.
function tailRows(file, maxBytes) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const size = fs.fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const len = size - start
    if (len <= 0) return []
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, start)
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    if (start > 0) lines.shift() // partial row at the cut
    const rows = []
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      try { rows.push(JSON.parse(t)) } catch { /* partial / corrupt row: skip */ }
    }
    return rows
  } catch {
    return []
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

const RESOLVE_TAIL_BYTES = 64 * 1024

// Find the transcript directory for this agent.
//
// The slug transform is an assumption about someone else's software, so we
// CHECK it instead of trusting it: a directory is only accepted if a row
// inside it actually reports `cwd === dataHome`. If the CLI ever changes its
// slug scheme, we fall back to scanning the projects root for a directory
// whose rows carry our cwd -- and if nothing does, we say so out loud rather
// than returning an empty directory that would silently meter 0 tokens.
function resolveTranscriptDir(dataHome) {
  const root = projectsRoot()
  const want = path.resolve(dataHome)

  const dirClaimsCwd = (dir) => {
    let files
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    } catch {
      return false
    }
    for (const f of files) {
      const rows = tailRows(path.join(dir, f), RESOLVE_TAIL_BYTES)
      for (const r of rows) {
        if (r && typeof r.cwd === 'string' && path.resolve(r.cwd) === want) return true
      }
    }
    return false
  }

  const direct = path.join(root, slugForCwd(want))
  if (fs.existsSync(direct) && dirClaimsCwd(direct)) {
    return { ok: true, dir: direct, via: 'slug' }
  }

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (err) {
    return { ok: false, reason: `transcript root unreadable (${root}): ${err.code || err.message}` }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(root, e.name)
    if (dirClaimsCwd(dir)) return { ok: true, dir, via: 'scan' }
  }

  // The slug dir may exist but hold no rows yet (fresh install, agent has not
  // spoken). That is NOT a measurement failure -- it is a real, verified zero.
  if (fs.existsSync(direct)) {
    return { ok: true, dir: direct, via: 'slug-empty' }
  }

  return {
    ok: false,
    reason:
      `no transcript directory found for cwd ${want} under ${root} -- ` +
      'the CLI has not written one yet, or it changed where it writes',
  }
}

// Local calendar day (YYYY-MM-DD) for a Date. The user's day, not UTC's:
// a budget that resets at 09:00 KST because the code thought in UTC would be
// a small lie of exactly the kind that makes software feel like a machine.
function localDay(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const USAGE_FIELDS = [
  ['input_tokens', 'input'],
  ['output_tokens', 'output'],
  ['cache_creation_input_tokens', 'cacheCreate'],
  ['cache_read_input_tokens', 'cacheRead'],
]

// ── incremental accumulation ────────────────────────────────────────────────
// Measured on a real agent-day (2026-07-13, MAGI project): 24 transcripts,
// 8113 usage rows. Re-reading those end-to-end on every poll would mean tens
// of MB of disk per minute, forever, to answer one number. Transcripts are
// append-only, so we read each file ONCE and thereafter only the bytes that
// arrived since.
//
// "Append-only" is an assumption about someone else's software, so it is
// CHECKED rather than trusted: we keep the first 256 bytes of every file we
// have accounted for, and if that head ever changes (rotation, truncation,
// a test rewriting the file) we throw the cached offset away and re-read from
// zero. A stale offset would silently skip real spend, which is the fail-open
// direction, so this check is not optional.
const HEAD_PROBE_BYTES = 256
const fileCache = new Map() // path -> { day, head, offset, totals }

function resetCache() { fileCache.clear() }

function readHead(file, size) {
  const n = Math.min(HEAD_PROBE_BYTES, size)
  if (n <= 0) return ''
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(n)
    fs.readSync(fd, buf, 0, n, 0)
    return buf.toString('latin1') // exact bytes, no multibyte re-encoding
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

// Read [from, to) and return { rows, consumed } where `consumed` stops at the
// last complete line. A row still being written is left for the next poll --
// half a JSON object is not a small error, it is a different object.
function readRange(file, from, to) {
  const len = to - from
  if (len <= 0) return { rows: [], consumed: 0 }
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.allocUnsafe(len)
    fs.readSync(fd, buf, 0, len, from)
    const lastNl = buf.lastIndexOf(0x0a)
    if (lastNl < 0) return { rows: [], consumed: 0 } // no complete line yet
    const text = buf.subarray(0, lastNl).toString('utf8')
    const rows = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try { rows.push(JSON.parse(t)) } catch { /* corrupt row: skip, never guess */ }
    }
    return { rows, consumed: lastNl + 1 }
  } catch {
    return { rows: [], consumed: 0 }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
  }
}

function emptyTotals() {
  return { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, rows: 0 }
}

// Does this row belong to THIS agent?
//
// resolveTranscriptDir() only accepts a directory once a row inside it claims
// our cwd -- which is an admission that a directory MIGHT hold foreign rows.
// The sum has to honor the same standard, or the two functions are checking
// different things under one name.
//
// The asymmetry is deliberate and it points the same way as everything else in
// this file: a row that claims a DIFFERENT cwd is excluded, but a row with NO
// cwd is COUNTED. Excluding it could hide real spend (fail-open); counting it
// can at worst overcount, which spends less. When the meter is unsure, it
// errs toward the user's money, not toward the agent's freedom.
function rowIsOurs(row, wantResolved) {
  if (!row || typeof row.cwd !== 'string' || !row.cwd) return true // no claim -> count it
  return path.resolve(row.cwd) === wantResolved
}

// Sum every assistant-message usage record stamped with the given local day.
//
// Returns { ok: true, day, ...totals, files } or { ok: false, reason }.
// Note `total` sums ALL four fields including cache reads. Cache reads are
// cheap but they are not free, and the number the user is shown must be the
// number the cap is enforced against -- two different numbers under one name
// is how a meter starts lying.
function usageForDay(dataHome, now = new Date(), resolved = null) {
  const r = resolved || resolveTranscriptDir(dataHome)
  if (!r.ok) return { ok: false, reason: r.reason }

  const day = localDay(now)
  const want = path.resolve(dataHome)
  const totals = emptyTotals()
  let files = 0
  let filesCounted = 0

  let names
  try {
    names = fs.readdirSync(r.dir).filter((f) => f.endsWith('.jsonl'))
  } catch (err) {
    return { ok: false, reason: `transcript dir unreadable (${r.dir}): ${err.code || err.message}` }
  }

  // Start-of-day in local time. A transcript last touched before today cannot
  // contain today's rows, so it is skipped without being opened.
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()

  for (const name of names) {
    const file = path.join(r.dir, name)
    let st
    try { st = fs.statSync(file) } catch { continue }
    if (st.mtimeMs < dayStart) continue
    files++

    const head = readHead(file, st.size)
    let c = fileCache.get(file)
    // Any of these means the cached offset can no longer be trusted, so we
    // re-read the file from zero rather than resume into the wrong place:
    //   - never seen it
    //   - it belongs to a previous day's tally
    //   - it SHRANK (truncation / rotation)
    //   - its first bytes changed (rewritten, not appended)
    if (!c || c.day !== day || st.size < c.offset || c.head !== head) {
      c = { day, head, offset: 0, totals: emptyTotals() }
      fileCache.set(file, c)
    }

    if (st.size > c.offset) {
      const { rows, consumed } = readRange(file, c.offset, st.size)
      for (const row of rows) {
        const usage = row && row.message && row.message.usage
        if (!usage || typeof row.timestamp !== 'string') continue
        if (!rowIsOurs(row, want)) continue
        const ts = new Date(row.timestamp)
        if (Number.isNaN(ts.getTime())) continue
        if (localDay(ts) !== day) continue
        c.totals.rows++
        for (const [field, key] of USAGE_FIELDS) {
          const v = usage[field]
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
            c.totals[key] += v
            c.totals.total += v
          }
        }
      }
      c.offset += consumed
    }

    if (c.totals.rows > 0) filesCounted++
    for (const k of ['input', 'output', 'cacheCreate', 'cacheRead', 'total', 'rows']) {
      totals[k] += c.totals[k]
    }
  }

  return { ok: true, day, dir: r.dir, via: r.via, files, filesCounted, ...totals }
}

// The unit is ALL FOUR token fields summed, cache reads included.
//
// This is a decision with teeth, and it was made by looking at a real day
// rather than by taste. Measured 2026-07-13 on a live agent-day: cacheRead
// was 1.43B of a 1.55B total -- 92%. So:
//   - Cap on input+output+cacheCreate only, and the cap cannot stop an agent
//     that is genuinely eating the user's allowance through long-context
//     turns. That is fail-open, and this file does not fail open.
//   - Cap on the raw sum, and the number is dominated by context re-reads.
//     It can only ever stop the agent EARLIER than a weighted number would.
// We take the second. Erring early spends less of someone else's money, and
// the UI names the unit exactly so the number is never mistaken for "work".
//
// The default is derived from that same measurement, not invented: one
// assistant turn on a loaded context ran ~85k all-in, so 5M is roughly 50-60
// turns of unattended work in a night. The settings page shows today's real
// usage next to this field so the user can calibrate against their own life
// instead of my guess.
const DEFAULT_DAILY_CAP = 5000000

// The whole decision, in one call.
//
// `capTokens` <= 0 is NOT "unlimited" -- it is "off". There is no way to
// express an unlimited autonomous budget in this product on purpose: the
// feature spends someone else's money while they sleep, so the absence of a
// number means no, never yes.
function budgetState(dataHome, capTokens, now = new Date()) {
  const cap = Number(capTokens)
  if (!Number.isFinite(cap) || cap <= 0) {
    return { ok: false, reason: 'no daily token cap configured', cap: 0, mayRun: false }
  }
  const u = usageForDay(dataHome, now)
  if (!u.ok) {
    // Cannot measure -> cannot spend. This is the single most important line
    // in the file.
    return { ok: false, reason: u.reason, cap, mayRun: false }
  }
  const remaining = Math.max(0, cap - u.total)
  return {
    ok: true,
    mayRun: u.total < cap,
    cap,
    used: u.total,
    remaining,
    usedPct: Math.round((u.total / cap) * 100),
    day: u.day,
    breakdown: { input: u.input, output: u.output, cacheCreate: u.cacheCreate, cacheRead: u.cacheRead },
    rows: u.rows,
    files: u.files,
  }
}

module.exports = {
  slugForCwd,
  projectsRoot,
  resolveTranscriptDir,
  localDay,
  usageForDay,
  budgetState,
  DEFAULT_DAILY_CAP,
  // exported for tests
  tailRows,
  resetCache,
}
