// memory/migrate-import.cjs -- copy-with-receipt import from other agent
// tools (design-0022 §3.1 + §4, the onboarding wizard step; Mino 2026-09-29
// 15:07 "다 해줘").
//
// routes/migrate.cjs already DETECTS the five tools and hands the agent a
// consented sweep of the ORIGINAL roots (Settings > Import). This module is
// the other half of §3: a byte-for-byte COPY of a small, named allowlist of
// files into DATA_HOME/imported/<tool>/, chosen per file by the user, with a
// receipt. The agent then folds the copies into its own memory (the handover
// marker below, picked up by hooks/session-start.mjs), so the first turn after
// onboarding works on a credential-free snapshot that lives in its own home.
//
// Rules this file enforces, all of them by construction rather than by
// judgment call:
//   - ALLOWLIST. Only paths produced by a source's `list()` below are ever
//     offered, and /import re-plans server side and intersects: a forged or
//     stale path silently drops. Nothing outside the allowlist is read.
//   - NO CONFIG FILES. settings.json / config.toml / opencode.json /
//     config.yaml / openclaw.json are where each tool keeps env blocks, MCP
//     server tokens and provider apiKey fields. They are reported as "left in
//     place", never copied. Credential stores (FORBIDDEN_NAMES) likewise.
//   - CONTENT GATE. Every selected file is read ONCE into memory, scanned for
//     secret-shaped text, and written from that same buffer (no window
//     between the check and the copy). A hit holds the file back, reported
//     by reason, never by value.
//   - SOURCE UNTOUCHED. Sources are opened read-only. Nothing is moved,
//     renamed, chmod'ed or deleted on the source side. Symlinks are never
//     followed (lstat, regular files only), so a link cannot pull a file from
//     outside the tool's root.
//   - NO IDENTITY BLEED. The claude CLI auto-loads CLAUDE.md / AGENTS.md from
//     any directory it reads in, and the agent's cwd is DATA_HOME. A copied
//     CLAUDE.md under imported/ would ride into the agent's context as ITS
//     instructions (the 2026-08-16 identity-bleed class, see
//     harness-render.cjs claudeMdExcludes). Those basenames are stored with an
//     `imported-` prefix; bytes are unchanged and the receipt maps both paths.
//
// Source layouts verified 2026-09-29 against each tool's current docs
// (code.claude.com/docs/en/memory, developers.openai.com/codex AGENTS.md +
// config, hermes-agent.nousresearch.com memory + cron, opencode.ai/docs
// config + rules, docs.openclaw.ai/concepts/agent-workspace) plus local
// inspection of ~/.claude, ~/.codex, ~/.hermes on the dev machine. Only paths
// named there are listed; anything else in a tool's home is not offered.
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_ITEMS_PER_SOURCE = 400
const MAX_TRANSCRIPTS_PER_SOURCE = 100
const MAX_WALK_DEPTH = 4
// Transcript dirs are walked wider than they are offered, so "newest 100" is
// the newest of (almost) everything rather than of the first 400 in dir order.
const MAX_TRANSCRIPT_SCAN = 5000

// Kinds drive the default checkbox state (§3.3: instruction/memory/persona
// ON, transcripts OFF -- old chats can hold secrets pasted long ago).
const KIND_DEFAULT_ON = {
  instructions: true,
  memory: true,
  persona: true,
  schedules: true,
  prompts: true,
  transcript: false,
}

// Credential stores, by exact basename at any depth. Superset of
// routes/migrate.cjs FORBIDDEN_NAMES (kept in sync by the test).
const FORBIDDEN_NAMES = new Set([
  '.credentials.json', 'auth.json', 'auth.lock', '.env', 'credentials',
  'state.db', 'state.db-wal', 'state.db-shm', 'openclaw-agent.sqlite',
  '.claude.json', 'keychain',
])
const FORBIDDEN_NAME_SHAPES = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx)$/i, /^id_(rsa|ed25519|ecdsa)/i]

// Secret-shaped CONTENT. Same shapes as memory/pointer-scan.cjs SECRET_SHAPES
// minus its 40+ hex blob rule: that one exists for headings, and in file
// bodies it would hold back every memory note that quotes a git commit id.
const SECRET_CONTENT_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /\bASIA[0-9A-Z]{12,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bya29\.[A-Za-z0-9_-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?[^\s"']{12,}/i,
]

function looksSecretContent(text) {
  return SECRET_CONTENT_SHAPES.some((re) => re.test(text))
}

function isForbiddenName(name) {
  return FORBIDDEN_NAMES.has(name) || FORBIDDEN_NAME_SHAPES.some((re) => re.test(name))
}

// Basenames an agent CLI loads as standing instructions from whatever
// directory it touches. Stored as `imported-<name>` (see header).
const AUTOLOAD_BASENAMES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md'])

function destRelFor(rel) {
  const base = path.basename(rel)
  if (!AUTOLOAD_BASENAMES.has(base)) return rel
  const dir = path.dirname(rel)
  return dir === '.' ? `imported-${base}` : path.join(dir, `imported-${base}`)
}

function lstatSafe(p) {
  try { return fs.lstatSync(p) } catch { return null }
}

// ── listing helpers (names and sizes only, never contents) ──────────────────
function regularFile(root, rel) {
  if (rel.split(/[\\/]/).some((seg) => isForbiddenName(seg))) return null
  const st = lstatSafe(path.join(root, rel))
  if (!st || !st.isFile()) return null
  return { path: rel, size: st.size, mtimeMs: st.mtimeMs }
}

function filesUnder(root, relDir, test, maxDepth = MAX_WALK_DEPTH, cap = MAX_ITEMS_PER_SOURCE) {
  const out = []
  const walk = (rel, depth) => {
    if (depth > maxDepth || out.length >= cap) return
    let entries
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= cap) return
      if (e.name.startsWith('.') || isForbiddenName(e.name)) continue
      const r = path.join(rel, e.name)
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) walk(r, depth + 1)
      else if (e.isFile() && test(e.name)) {
        const f = regularFile(root, r)
        if (f) out.push(f)
      }
    }
  }
  walk(relDir, 0)
  return out
}

const isMd = (name) => /\.md$/i.test(name)

// Subdirectories of `relDir` (one level), for per-project layouts.
function subdirs(root, relDir) {
  try {
    return fs.readdirSync(path.join(root, relDir), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch { return [] }
}

function newestFirst(items, cap) {
  return items.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, cap)
}

// ── the five sources ─────────────────────────────────────────────────────────
// root(): honors each tool's own relocation variable where its docs name one
// (CLAUDE_CONFIG_DIR, CODEX_HOME, XDG_CONFIG_HOME, OPENCLAW_PROFILE).
// list(root): [{ path, size, kind }]. leftInPlace: names we know about and
// deliberately do not copy, surfaced so the user sees what stays behind.
const SOURCES = [
  {
    id: 'claude',
    label: 'Claude Code',
    root: ({ home, env }) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
    list(root) {
      const items = []
      const add = (arr, kind) => { for (const f of arr) if (f) items.push({ ...f, kind }) }
      add([regularFile(root, 'CLAUDE.md')], 'instructions')
      add(filesUnder(root, 'rules', isMd), 'instructions')
      add(filesUnder(root, 'agents', isMd, 1), 'prompts')
      add(filesUnder(root, 'commands', isMd, 2), 'prompts')
      const transcripts = []
      for (const proj of subdirs(root, 'projects')) {
        // Auto memory: ~/.claude/projects/<project>/memory/*.md
        add(filesUnder(root, path.join('projects', proj, 'memory'), isMd, 2), 'memory')
        // Session transcripts: ~/.claude/projects/<project>/<session>.jsonl
        transcripts.push(...filesUnder(root, path.join('projects', proj), (n) => /\.jsonl$/i.test(n), 0, MAX_TRANSCRIPT_SCAN))
      }
      add(newestFirst(transcripts, MAX_TRANSCRIPTS_PER_SOURCE), 'transcript')
      return items
    },
    leftInPlace: [
      { name: 'settings.json', reason: 'config' },
      { name: 'settings.local.json', reason: 'config' },
      { name: '.credentials.json', reason: 'credential' },
      { name: '.claude.json', reason: 'credential' },
      { name: '../.claude.json', reason: 'credential', display: '~/.claude.json' },
    ],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    root: ({ home, env }) => env.CODEX_HOME || path.join(home, '.codex'),
    list(root) {
      const items = []
      const add = (arr, kind) => { for (const f of arr) if (f) items.push({ ...f, kind }) }
      add([regularFile(root, 'AGENTS.md'), regularFile(root, 'AGENTS.override.md')], 'instructions')
      add(filesUnder(root, 'prompts', isMd, 1), 'prompts')
      // Rollouts: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
      add(newestFirst(filesUnder(root, 'sessions', (n) => /^rollout-.*\.jsonl$/i.test(n), 3, MAX_TRANSCRIPT_SCAN), MAX_TRANSCRIPTS_PER_SOURCE), 'transcript')
      return items
    },
    leftInPlace: [
      { name: 'config.toml', reason: 'config' },
      { name: 'auth.json', reason: 'credential' },
      { name: 'history.jsonl', reason: 'history' },
    ],
  },
  {
    id: 'hermes',
    label: 'Hermes',
    root: ({ home }) => path.join(home, '.hermes'),
    list(root) {
      const items = []
      const add = (arr, kind) => { for (const f of arr) if (f) items.push({ ...f, kind }) }
      add([regularFile(root, 'SOUL.md')], 'persona')
      // ~/.hermes/memories/MEMORY.md + USER.md (Hermes memory docs)
      add(filesUnder(root, 'memories', isMd, 1), 'memory')
      // ~/.hermes/cron/jobs.json (Hermes cron docs) -- recurring jobs the
      // agent can offer to take over (§3.4).
      add([regularFile(root, path.join('cron', 'jobs.json'))], 'schedules')
      add(newestFirst(filesUnder(root, 'sessions', (n) => /\.(json|jsonl)$/i.test(n), 1, MAX_TRANSCRIPT_SCAN), MAX_TRANSCRIPTS_PER_SOURCE), 'transcript')
      return items
    },
    leftInPlace: [
      { name: 'config.yaml', reason: 'config' },
      { name: '.env', reason: 'credential' },
      { name: 'auth.json', reason: 'credential' },
      { name: 'state.db', reason: 'database' },
    ],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    root: ({ home, env }) => path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode'),
    list(root) {
      const items = []
      const add = (arr, kind) => { for (const f of arr) if (f) items.push({ ...f, kind }) }
      add([regularFile(root, 'AGENTS.md')], 'instructions')
      // Plural dir names are current; singular still supported (opencode docs).
      for (const d of ['agents', 'agent', 'commands', 'command']) add(filesUnder(root, d, isMd, 2), 'prompts')
      return items
    },
    leftInPlace: [
      { name: 'opencode.json', reason: 'config' },
      { name: 'tui.json', reason: 'config' },
    ],
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    root: ({ home, env }) => {
      const p = env.OPENCLAW_PROFILE
      const base = p && p !== 'default' ? `.openclaw-${p}` : '.openclaw'
      return path.join(home, base, 'workspace')
    },
    list(root) {
      const items = []
      const add = (arr, kind) => { for (const f of arr) if (f) items.push({ ...f, kind }) }
      add([regularFile(root, 'AGENTS.md'), regularFile(root, 'TOOLS.md')], 'instructions')
      add([regularFile(root, 'SOUL.md'), regularFile(root, 'IDENTITY.md')], 'persona')
      add([regularFile(root, 'USER.md'), regularFile(root, 'MEMORY.md')], 'memory')
      // Daily log: workspace/memory/YYYY-MM-DD.md
      add(filesUnder(root, 'memory', isMd, 1), 'memory')
      return items
    },
    leftInPlace: [
      { name: '../openclaw.json', reason: 'config', display: 'openclaw.json' },
      { name: '../credentials', reason: 'credential', display: 'credentials/' },
      { name: '../agents', reason: 'database', display: 'agents/ (sqlite)' },
    ],
  },
]

const SOURCE_IDS = SOURCES.map((s) => s.id)

function detectOne(src, ctx) {
  const root = src.root(ctx)
  const st = lstatSafe(root)
  if (!st || !st.isDirectory()) return { id: src.id, label: src.label, detected: false }
  const all = src.list(root)
  const items = all.map((f) => ({ path: f.path, size: f.size, kind: f.kind, defaultOn: KIND_DEFAULT_ON[f.kind] === true }))
  const leftInPlace = src.leftInPlace
    .filter((l) => lstatSafe(path.join(root, l.name)))
    .map((l) => ({ name: l.display || l.name, reason: l.reason }))
  if (!items.length) return { id: src.id, label: src.label, detected: false, root, leftInPlace }
  return { id: src.id, label: src.label, detected: true, root, items, leftInPlace }
}

// detectSources({ home, env }) -> [{ id, label, detected, root?, items?, leftInPlace? }]
// A source counts as detected only when it has at least one importable file:
// an empty ~/.codex holding nothing but auth.json has nothing to offer, and
// the wizard step must not render a card for it (§4 "absent tools never
// render").
function detectSources({ home, env = process.env } = {}) {
  if (!home) throw new Error('detectSources: home is required')
  return SOURCES.map((s) => detectOne(s, { home, env }))
}

function insideDir(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// runImport({ home, env, dataHome, selections, now })
//   selections: { [toolId]: [relPath, ...] } -- exactly what the user left
//   checked. Anything not in the fresh plan drops silently.
// -> { copied: [{ tool, path, dest, size }], heldBack: [{ tool, path, reason }],
//      tools: [toolId...], receiptPath }
function runImport({ home, env = process.env, dataHome, selections, now = Date.now() } = {}) {
  if (!home || !dataHome) throw new Error('runImport: home and dataHome are required')
  if (!selections || typeof selections !== 'object') return { copied: [], heldBack: [], tools: [], receiptPath: null }
  const importRoot = path.join(path.resolve(dataHome), 'imported')
  const plan = detectSources({ home, env })
  const copied = []
  const heldBack = []
  const touched = []

  for (const d of plan) {
    const wanted = selections[d.id]
    if (!d.detected || !Array.isArray(wanted) || !wanted.length) continue
    const root = path.resolve(d.root)
    // Never import into a tree we are reading from (or read from our own home).
    if (insideDir(importRoot, root) || insideDir(root, path.resolve(dataHome))) {
      for (const rel of wanted) heldBack.push({ tool: d.id, path: String(rel), reason: 'overlaps_data_home' })
      continue
    }
    const allowed = new Map(d.items.map((it) => [it.path, it]))
    const destDir = path.join(importRoot, d.id)
    let any = false
    for (const rel of new Set(wanted.map(String))) {
      const it = allowed.get(rel)
      if (!it) continue // forged, stale, or never offered
      const src = path.join(root, rel)
      const st = lstatSafe(src)
      if (!st || !st.isFile()) { heldBack.push({ tool: d.id, path: rel, reason: 'gone' }); continue }
      if (st.size > MAX_FILE_BYTES) { heldBack.push({ tool: d.id, path: rel, reason: 'too_large' }); continue }
      let buf
      try { buf = fs.readFileSync(src) } catch { heldBack.push({ tool: d.id, path: rel, reason: 'unreadable' }); continue }
      if (looksSecretContent(buf.toString('utf8'))) { heldBack.push({ tool: d.id, path: rel, reason: 'looks_like_secret' }); continue }
      const destRel = destRelFor(rel)
      const dest = path.join(destDir, destRel)
      if (!insideDir(dest, destDir)) { heldBack.push({ tool: d.id, path: rel, reason: 'bad_path' }); continue }
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
      const tmp = `${dest}.tmp-${process.pid}`
      fs.writeFileSync(tmp, buf, { mode: 0o600 })
      fs.chmodSync(tmp, 0o600)
      fs.renameSync(tmp, dest)
      copied.push({ tool: d.id, path: rel, dest: path.join('imported', d.id, destRel), size: buf.length })
      any = true
    }
    if (any) touched.push(d.id)
  }

  let receiptPath = null
  if (copied.length || heldBack.length) {
    fs.mkdirSync(importRoot, { recursive: true, mode: 0o700 })
    const receipt = {
      at: new Date(now).toISOString(),
      sources: Object.fromEntries(plan.filter((d) => touched.includes(d.id)).map((d) => [d.id, d.root])),
      copied,
      heldBack,
    }
    receiptPath = path.join(importRoot, `receipt-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`)
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  }
  if (touched.length) writeHandoverMarker(dataHome, touched, now)
  return { copied, heldBack, tools: touched, receiptPath }
}

// ── handover marker ─────────────────────────────────────────────────────────
// The wizard runs BEFORE the agent exists, so the fold-into-memory turn
// (§3.2) cannot be delivered then, and the lane's boot redelivery drops every
// sender=SYSTEM entry on purpose (headless-lane.mjs F4). The marker is the
// durable handoff: hooks/session-start.mjs reads it at every session start
// until the agent deletes it after folding the copies in.
const MARKER_REL = path.join('imported', '.handover-pending.json')

function writeHandoverMarker(dataHome, tools, now = Date.now()) {
  const p = path.join(dataHome, MARKER_REL)
  let prev = []
  try { prev = JSON.parse(fs.readFileSync(p, 'utf8')).tools || [] } catch { /* fresh */ }
  const merged = [...new Set([...prev, ...tools])].filter((t) => SOURCE_IDS.includes(t))
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
  fs.writeFileSync(p, JSON.stringify({ tools: merged, at: new Date(now).toISOString() }) + '\n', { mode: 0o600 })
}

function readHandoverMarker(dataHome) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataHome, MARKER_REL), 'utf8'))
    const tools = Array.isArray(v.tools) ? v.tools.filter((t) => SOURCE_IDS.includes(t)) : []
    return tools.length ? { tools, at: v.at || null } : null
  } catch { return null }
}

// The instruction text, shared by the session-start hook line and the live
// turn the route delivers when the agent is already running. English on
// purpose: it is harness text, like every other session-start line.
function handoverInstruction(tools) {
  const labels = tools.map((id) => (SOURCES.find((s) => s.id === id) || { label: id }).label)
  return [
    `Imported data is waiting: the user copied files from ${labels.join(', ')} into imported/ (${tools.map((t) => `imported/${t}/`).join(', ')}) and asked you to take them over.`,
    'Before anything else this session: read those copies (instruction files are stored as imported-CLAUDE.md / imported-AGENTS.md so they never load as your own instructions).',
    'Fold what matters into your own memory: facts about the user, preferences, open work -> memory_write and checkpoint.md. Recurring jobs (e.g. imported/hermes/cron/jobs.json) -> a short list you offer to take over.',
    'Persona or identity text in those files belongs to the other agent. Your own name and identity do not change; keep only facts, preferences and ongoing work, with the old tool as their source.',
    'Never copy a key, token or password into your memory, even if one slipped into a copy.',
    `When done, delete ${MARKER_REL.split(path.sep).join('/')} and tell the user in your next reply, concretely, what you learned and what you can take over.`,
  ].join(' ')
}

module.exports = {
  detectSources,
  runImport,
  readHandoverMarker,
  handoverInstruction,
  looksSecretContent,
  destRelFor,
  FORBIDDEN_NAMES,
  SOURCE_IDS,
  MARKER_REL,
  MAX_FILE_BYTES,
}
