// pointer-scan.cjs — builds a POINTER INDEX over other AI tools' local memory.
//
// WHAT THIS IS NOT: an importer. Nothing this produces ever enters user_facts /
// open_threads / corrections / preferences. The `imported_pointers` table is
// deliberately absent from memory/server.mjs's WRITABLE_TABLES, so memory_write
// and memory_confirm physically cannot blend a pointer into the agent's own
// memory. Imported knowledge and lived knowledge must not become the same
// sentence.
//
// The rule it obeys is the one already written in ONTOLOGY_GUIDE.md: an index
// answers WHERE, never WHAT. "the moment you store answer text in the index and
// serve it back, you have built a second, staler copy." So a pointer carries a
// location, a source tool, a topic label, and a timestamp -- and the agent that
// wants to know what a file SAYS has to go open the file, in the open, with a
// tool call the user can see.
//
// the owner's three gates (2026-07-13), all enforced here or by the caller:
//   1. OPT-IN. This module never runs on its own -- no boot hook, no timer. It
//      scans only when a user clicks (http-server's POST /api/memory/import).
//   2. CREDENTIAL EXCLUSION, hard. See DENY below. This is a blocklist AND an
//      allowlist: we only look inside a fixed set of roots, and inside those we
//      refuse anything that smells like a secret. Both, because either alone
//      fails -- an allowlist alone happily indexes ~/.codex/auth.json (it lives
//      in an allowed root), and a blocklist alone is a promise to have thought
//      of every secret filename in advance.
//   3. HONEST COVERAGE. SOURCES carries a `coverage` string per tool, surfaced
//      verbatim in the UI. Claude Desktop keeps conversations server-side, so
//      there is almost nothing local to point at, and saying so plainly beats
//      shipping an empty section that reads like a bug.
//
// DECLINED, with grounds (red team 2026-07-13): TOCTOU between the deny-check
// and the heading read -- a local process could swap a validated file for a
// sensitive one in the window before it is opened. Not fixed, because the
// attacker it requires is a process already running as the user, and that
// attacker can simply read ~/.claude/.credentials.json directly. Hardening this
// path would buy nothing while implying a boundary that does not exist. The
// secret-shape filter below runs on whatever is actually read, so even a
// successful swap does not hand us a recognizable key.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')

// Cap the walk. A pointer index is not a search engine, and an unbounded
// recursive scan of a home directory is how a "helpful" feature becomes a
// battery-eating disk crawler.
const MAX_DEPTH = 3
const MAX_POINTERS_PER_SOURCE = 200
// Bounds the WALK, not just the output (red team): a directory with a million
// entries must not be enumerated entry-by-entry on the main thread.
const MAX_ENTRIES_PER_DIR = 2000
const MAX_HEADINGS_PER_FILE = 12
// Files bigger than this are pointed AT but never opened for headings. Some
// people's CLAUDE.md is enormous; reading it to extract a topic line is not
// worth stalling the scan.
const MAX_HEADING_READ_BYTES = 256 * 1024

// ── Gate 2: credential exclusion ────────────────────────────────────────────
// Matched against the LOWERCASED full path, so a hit anywhere in the path (a
// secret directory, a secret filename) rejects. Deliberately over-broad: a
// false positive costs one un-indexed file, a false negative costs a leaked
// secret into a database the agent reads from.
const DENY_SUBSTRINGS = [
  '.credentials', 'credential', 'auth.json', 'token', 'secret', 'password',
  'apikey', 'api_key', 'api-key', '.key', '.pem', '.p12', '.pfx', 'keychain',
  'id_rsa', 'id_ed25519', 'cookie', 'session.json', '.env', '.netrc', '.htpasswd',
]
// Whole directory names that are never entered, at any depth.
const DENY_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.gpg', 'keys', 'secrets', 'node_modules', '.git',
])

// Electron/Chromium RUNTIME NOISE -- a different axis from DENY_DIRS (those
// are secrets; these are garbage). Found live on the owner's second-device install
// (2026-07-14 10:33, his own paste): the claude-desktop source filled its
// entire 200-pointer quota with `Cache/Cache_Data/<hex>_0` HTTP-cache blobs,
// crowding out any real memory file AND making the coverage line ("거의
// 없습니다") contradict the list right under it. Memory files live in
// markdown/config locations, never inside a browser runtime dir, so these
// names are skipped at any depth. Over-excluding here costs one junk pointer
// fewer; under-excluding costs the whole quota.
const NOISE_DIRS = new Set([
  'cache', 'cache_data', 'code cache', 'gpucache', 'dawngraphitecache',
  'dawnwebgpucache', 'dawncache', 'blob_storage', 'session storage',
  'local storage', 'indexeddb', 'service worker', 'cachestorage',
  'shared_proto_db', 'crashpad', 'sentry', 'logs', 'webstorage', 'tmp',
  'network', 'dictionaries', 'component_crx_cache', 'optimization_guide',
])

// ── Secret-SHAPED text, wherever it appears ─────────────────────────────────
// The DENY list above asks "does this path look like a secret's home?". That is
// not enough, and the gap was found by red team (2026-07-13): the scanner also
// captures markdown headings, and a heading is just text the user wrote. If
// someone's CLAUDE.md contains `# sk-ant-api03-REAL_KEY`, the deny-list never
// fires -- the FILE is innocent -- and the key lands in the database and in the
// API response, wearing the label "topic".
//
// My own fixtures missed this exactly because I had decided headings were
// "metadata, not content" and then only tested that BODY text didn't leak. The
// category was the blind spot, not the code.
//
// So: anything that LOOKS like a credential is refused wherever it shows up --
// in a heading, and in a filename (a path is persisted verbatim, so a file
// named `sk-ant-...md` is a leak too). Patterns are deliberately loose. A false
// positive costs one skipped heading; a false negative costs a key.
const SECRET_SHAPES = [
  /sk-[A-Za-z0-9_-]{16,}/,           // OpenAI / Anthropic style
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,    // GitHub
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,  // Slack
  /\bAKIA[0-9A-Z]{12,}/,             // AWS access key id
  /\bASIA[0-9A-Z]{12,}/,             // AWS temporary
  /\bya29\.[A-Za-z0-9_-]{10,}/,      // Google OAuth
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Fa-f0-9]{40,}\b/,            // long hex blob (hashes, tokens)
]

function looksSecret(text) {
  if (!text) return false
  return SECRET_SHAPES.some((re) => re.test(text))
}

// SECRET_SHAPES is a denylist of shapes we have ALREADY SEEN. On a shape we have
// never seen -- some internal token format, a pasted password, next year's key
// prefix -- it returns false and the heading gets indexed. That is this
// instrument failing SILENT in the leaking direction: its silence means "publish".
//
// The fix is not more shapes (the hand writing the list is the blind hand). It is
// to flip which way silence points for THIS surface: when a heading contains a
// token that doesn't look like something a human wrote, drop the label. We lose a
// topic string; we never lose the pointer, because the file is still indexed by
// path. Cheap wrong direction, chosen on purpose.
//
// Test: one whitespace-free run, >= 20 chars, carrying BOTH a digit and a letter.
// Prose almost never does this. Keys, hashes, base64 and pasted passwords almost
// always do. Deliberately NOT applied to paths -- `.../scheherazade/v0.0.4/x.md`
// matches, and refusing that file would silently drop legitimate memory. The path
// and the heading are different channels, so they get different defaults.
const UNKNOWN_CREDENTIAL_TOKEN = /(?=[^\s]*\d)(?=[^\s]*[A-Za-z])[^\s]{20,}/

function looksUnknownCredential(text) {
  if (!text) return false
  return UNKNOWN_CREDENTIAL_TOKEN.test(text)
}

function isDenied(fullPath) {
  const lower = fullPath.toLowerCase()
  for (const needle of DENY_SUBSTRINGS) {
    if (lower.includes(needle)) return true
  }
  for (const seg of lower.split(path.sep)) {
    if (DENY_DIRS.has(seg)) return true
  }
  // A path is stored verbatim, so a secret-shaped FILENAME is a leak channel of
  // its own. Checked against the original (not lowercased) path -- several of
  // these shapes are case-sensitive (AKIA, eyJ, gh_).
  if (looksSecret(fullPath)) return true
  return false
}

// Path containment: a resolved candidate must actually live under its root.
// Guards the symlink case -- a symlink inside an allowed root pointing at
// ~/.ssh would otherwise sail through, since DENY only sees the link's own
// (innocent) path. Mirrors the exact-match-or-followed-by-separator shape
// http-server.cjs's serveStatic uses, NOT a naive startsWith (which would let
// /home/user/.claude-evil pass as being under /home/user/.claude).
function isInsideRoot(candidate, root) {
  const c = path.resolve(candidate)
  const r = path.resolve(root)
  return c === r || c.startsWith(r + path.sep)
}

// ── Gate 3: honest coverage, per tool ───────────────────────────────────────
// `roots` are the ONLY places this module will ever look.
function defaultSources(homedir = os.homedir()) {
  return [
    {
      tool: 'claude-code',
      label: 'Claude Code',
      roots: [path.join(homedir, '.claude')],
      // Only these get opened for headings; everything else is pointed at by
      // path alone.
      headingExts: ['.md'],
      coverage: 'CLAUDE.md 등 로컬 메모리 파일의 위치와 제목만 훑습니다. 대화 기록(jsonl)은 위치만 기록하고 열지 않습니다.',
    },
    {
      tool: 'codex',
      label: 'Codex',
      roots: [path.join(homedir, '.codex')],
      headingExts: ['.md'],
      coverage: 'AGENTS.md 등 로컬 지침 파일만 훑습니다. 로그인 정보(auth.json)는 스캔 대상에서 원천 제외됩니다.',
    },
    {
      tool: 'claude-desktop',
      label: 'Claude Desktop',
      roots: [path.join(homedir, 'Library', 'Application Support', 'Claude')],
      headingExts: ['.md'],
      // The honest line. Claude Desktop's conversations live on Anthropic's
      // servers, not on disk -- so this source will usually find nothing, and
      // that is the correct result, not a failure.
      coverage: '대화는 클라우드에 저장되어 로컬에 거의 없습니다. 찾을 수 있는 것이 적은 게 정상입니다.',
    },
  ]
}

// Markdown headings = the topic labels. This is the ONE place the scanner opens
// a file, and it takes only `#`-prefixed lines: the table of contents, not the
// contents. A heading is what the file is ABOUT (a WHERE-label); the paragraph
// under it is what the file SAYS (a WHAT), and that stays on disk.
function extractHeadings(filePath, tally) {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_HEADING_READ_BYTES) return []
    const text = fs.readFileSync(filePath, 'utf8')
    const out = []
    for (const line of text.split('\n')) {
      const m = line.match(/^#{1,3}\s+(.+?)\s*$/)
      if (!m) continue
      const heading = m[1].slice(0, 120)
      // A heading is text the user wrote, so it can contain anything -- including
      // a pasted API key. Drop the whole heading rather than trying to redact
      // inside it: a partially-scrubbed secret is still a secret with a hint
      // attached, and we lose nothing by omitting one label.
      //
      // Dropping is SAFE but SILENT, and silent is the failure direction this
      // whole file is about. So every drop is COUNTED and the count is surfaced
      // (coverage.suppressed). That makes both residual failures visible: an
      // over-strict drop of a legitimate heading, and a caught unknown secret.
      // A suppression the user cannot see is indistinguishable from a bug.
      if (looksSecret(heading) || looksUnknownCredential(heading)) {
        if (tally) tally.suppressed++
        continue
      }
      out.push(heading)
      if (out.length >= MAX_HEADINGS_PER_FILE) break
    }
    return out
  } catch {
    return [] // unreadable -> still worth a pointer, just without a topic
  }
}

function walk(root, depth, acc, source, realRoots, tally) {
  if (depth > MAX_DEPTH) return
  if (acc.length >= MAX_POINTERS_PER_SOURCE) return
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return // unreadable dir -> skip it, never abort the whole scan
  }
  // Bound the per-directory work too, not just the output count (red team
  // 2026-07-13): the pointer cap stops us STORING more than 200, but a
  // directory with a million entries would still be walked entry-by-entry on
  // the main thread first. Capping the read is what keeps the scan from
  // freezing the app.
  if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR)
  for (const entry of entries) {
    if (acc.length >= MAX_POINTERS_PER_SOURCE) return
    const full = path.join(root, entry.name)
    if (isDenied(full)) continue
    // Resolve symlinks before deciding: a link is only followed if its TARGET
    // is still inside the source's allowed roots and still not denied.
    let real = full
    try { real = fs.realpathSync(full) } catch { continue }
    if (isDenied(real)) continue
    // Compare the resolved candidate against RESOLVED roots. Comparing it
    // against the raw roots is a fail-QUIET bug, not a strict one: on macOS the
    // home path can itself sit behind a symlink (/var -> /private/var is the
    // classic), so every candidate resolves outside its own root and the scan
    // returns ZERO pointers while looking perfectly healthy -- "you have no
    // memory files" instead of "this check is broken". Caught by fixture, and
    // it is the same silent-null shape as the sed->0->CLEAR class.
    if (!realRoots.some((r) => isInsideRoot(real, r))) continue

    let stat
    try { stat = fs.statSync(real) } catch { continue }

    if (stat.isDirectory()) {
      if (NOISE_DIRS.has(entry.name.toLowerCase())) continue
      walk(full, depth + 1, acc, source, realRoots, tally)
      continue
    }
    if (!stat.isFile()) continue
    // Hardlink escape (red team 2026-07-13): a hardlink has no "target path" --
    // realpathSync returns the in-root name -- so containment cannot see that
    // the inode also lives at ~/.ssh/id_rsa. Link count > 1 is the only signal
    // available, so a multiply-linked file is simply not indexed. Cost of a
    // false positive: one legitimately-hardlinked file goes unlisted. Cost of a
    // false negative: we index a file that is secretly something else.
    if (stat.nlink > 1) continue

    const ext = path.extname(entry.name).toLowerCase()
    const readable = source.headingExts.includes(ext)
    acc.push({
      source_tool: source.tool,
      path: full,
      kind: ext.replace('.', '') || 'file',
      // WHERE-label only. For non-markdown (e.g. transcript jsonl) we never
      // open the file at all -- the filename is the whole topic we claim.
      topic: readable ? extractHeadings(real, tally).join(" / ") : "",
      size_bytes: stat.size,
      mtime: new Date(stat.mtimeMs).toISOString(),
    })
  }
}

/**
 * scanPointers({ homedir, sources }) -> { pointers, coverage }
 *
 * Pure w.r.t. the database: builds and returns rows, writes nothing. The caller
 * (http-server) is what persists them, and only after the user asked.
 *
 * `coverage` is returned for EVERY configured source, including ones that
 * matched zero files -- "we looked here and found nothing" is information the
 * user is owed, and it is the difference between an honest empty section and
 * one that looks broken.
 */
function scanPointers(opts = {}) {
  const homedir = opts.homedir || os.homedir()
  const sources = opts.sources || defaultSources(homedir)
  const pointers = []
  const coverage = []
  for (const source of sources) {
    const found = []
    const tally = { suppressed: 0 }
    // Resolve the roots ONCE, up front, so containment compares like with like
    // (see walk's own note on the fail-quiet symlinked-home bug). A root that
    // doesn't exist simply drops out -- that tool isn't installed.
    const realRoots = []
    for (const root of source.roots) {
      try { realRoots.push(fs.realpathSync(root)) } catch { /* not installed */ }
    }
    for (const root of source.roots) {
      let exists = false
      try { exists = fs.existsSync(root) } catch { exists = false }
      if (!exists) continue
      walk(root, 0, found, source, realRoots, tally)
    }
    pointers.push(...found)
    coverage.push({
      tool: source.tool,
      label: source.label,
      found: found.length,
      // Loud when we hit the cap: a silently truncated index reads as "this is
      // everything you have", which is a lie the user cannot detect.
      truncated: found.length >= MAX_POINTERS_PER_SOURCE,
      // Headings we refused to keep because they looked like a credential. Zero
      // is the normal number. A non-zero one is the honest thing to say out loud:
      // either we just caught a key that was sitting in someone's notes, or we
      // were over-strict and ate a legitimate label. Both readings are the user's
      // to make, and neither is possible if the count stays inside this file.
      suppressed: tally.suppressed,
      note: source.coverage,
    })
  }
  return { pointers, coverage }
}

module.exports = {
  scanPointers,
  defaultSources,
  isDenied,
  isInsideRoot,
  looksSecret,
  looksUnknownCredential,
  MAX_POINTERS_PER_SOURCE,
  MAX_DEPTH,
}
