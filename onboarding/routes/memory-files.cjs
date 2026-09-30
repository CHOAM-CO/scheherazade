// onboarding/routes/memory-files.cjs -- read-only browse of the agent's home
// folder for the Memory page's folder view (0.3.8, Mino: "폴더 탐색하듯").
//
//   GET /api/agent-files/tree              -- nested listing of DATA_HOME
//   GET /api/agent-files/file?path=<rel>   -- one file's text
//
// Deliberately NOT under /api/memory/*: that prefix ends in a
// /api/memory/:table matcher that would swallow a `tree` segment.
//
// What is exposed is an ALLOWLIST, not "everything except secrets":
//   - only .md / .txt / .json files (case-insensitive),
//   - no dot-segment anywhere in the path (.gates, .claude, .archive, .env...),
//   - no segment that looks like a credential (token, key, secret, auth,
//     cookie, password, credential, .env, .pem ...) -- checked on the
//     requested path AND on the realpath it resolves to,
//   - the realpath must sit inside realpath(DATA_HOME), so a symlink pointing
//     out is a 403 and a symlink pointing at a credential inside is a 403 too,
//   - the tree never follows symlinks at all.
// Paths in and out are RELATIVE to DATA_HOME with "/" separators. An absolute
// path, a "..", a NUL, or a drive letter is a 400.
//
// Same binding rules as every route group: bodies only, deps bound ONCE from
// staticCtx, no requires back into http-server.cjs.
'use strict'

const ALLOWED_EXT = new Set(['.md', '.txt', '.json'])
const MAX_DEPTH = 5
const MAX_NODES = 1500
const MAX_FILE_BYTES = 512 * 1024
// Word-ish fragments, matched case-insensitively against every path segment.
// Over-matching (e.g. "author-notes.md" hidden by "auth") is the accepted
// price: a hidden note is a nuisance, a shown credential is an incident.
const CREDENTIAL_RE = /(token|secret|passw|credential|api[-_ ]?key|apikey|private|cookie|auth|oauth|keychain|\.env|\.pem|\.p12|\.key$|id_rsa|\.npmrc|\.netrc|session[-_]?key|bearer)/i
// Folders the app itself fills (vendored chromux docs under bin/, deps): not
// the agent's notes, and hundreds of files of noise in a memory browser.
const APP_OWNED = new Set(['bin', 'node_modules'])
const DATE_NAME_RE = /^\d{4}-\d{2}-\d{2}/
// Scratch and backup folders (tmp/, "fabric26.3-fix-backup-2026...") are not
// memory; the owner 2026-09-30 screenshot showed them in the tree. Hidden from
// the tree only -- files inside stay readable (Recent may still link to them).
const NOISE_DIR_RE = /^(tmp|temp|cache)$|backup|\.bak/i

function createRoutes(staticCtx) {
  const { fs, path, sendJson, DATA_HOME } = staticCtx

  function segmentsAllowed(segments, isFile) {
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (!s || s === '.' || s === '..' || s.startsWith('.')) return false
      if (CREDENTIAL_RE.test(s)) return false
      if (APP_OWNED.has(s)) return false
    }
    if (isFile) {
      const ext = path.extname(segments[segments.length - 1]).toLowerCase()
      if (!ALLOWED_EXT.has(ext)) return false
    }
    return true
  }

  function realRoot() {
    try { return fs.realpathSync(DATA_HOME) } catch { return null }
  }

  function listDir(absDir, depth, budget) {
    let names
    try { names = fs.readdirSync(absDir) } catch { return [] }
    const out = []
    for (const name of names) {
      if (budget.left <= 0) { budget.truncated = true; break }
      if (name.startsWith('.') || CREDENTIAL_RE.test(name) || APP_OWNED.has(name)) continue
      const abs = path.join(absDir, name)
      let st
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (NOISE_DIR_RE.test(name)) continue
        if (depth >= MAX_DEPTH) { budget.depthCapped = true; continue }
        const children = listDir(abs, depth + 1, budget)
        if (children.length === 0) continue // empty (or all-filtered) folders are noise
        budget.left--
        out.push({ name, type: 'dir', mtime: st.mtimeMs, children })
      } else if (st.isFile()) {
        if (!ALLOWED_EXT.has(path.extname(name).toLowerCase())) continue
        budget.left--
        out.push({ name, type: 'file', size: st.size, mtime: st.mtimeMs })
      }
    }
    // A folder of date-named entries reads as a timeline: newest first.
    // Anything else: folders before files, then A-Z.
    const dated = out.length > 0 && out.filter((n) => DATE_NAME_RE.test(n.name)).length * 2 > out.length
    out.sort((a, b) => {
      if (dated) return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return out
  }

  // Attach the relative path to every node once the walk is done (keeps
  // listDir free of path bookkeeping).
  function stamp(nodes, prefix) {
    for (const n of nodes) {
      n.path = prefix ? `${prefix}/${n.name}` : n.name
      if (n.children) stamp(n.children, n.path)
    }
  }

  return [
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/agent-files/tree',
      handler: async (req, res) => {
        const root = realRoot()
        if (!root) {
          sendJson(res, 200, { root: DATA_HOME, exists: false, nodes: [], truncated: false, depthCapped: false })
          return
        }
        const budget = { left: MAX_NODES, truncated: false, depthCapped: false }
        const nodes = listDir(root, 1, budget)
        stamp(nodes, '')
        sendJson(res, 200, { root, exists: true, nodes, truncated: budget.truncated, depthCapped: budget.depthCapped })
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/agent-files/file',
      handler: async (req, res) => {
        const rel = new URL(req.url, 'http://127.0.0.1').searchParams.get('path') || ''
        if (!rel || rel.includes('\0') || rel.length > 1024) {
          sendJson(res, 400, { error: 'path is required' })
          return
        }
        // Absolute (posix, UNC, drive letter) and traversal are refused before
        // touching the disk.
        if (rel.startsWith('/') || rel.startsWith('\\') || /^[A-Za-z]:/.test(rel) || path.isAbsolute(rel)) {
          sendJson(res, 400, { error: 'path must be relative to the agent folder' })
          return
        }
        const segments = rel.split(/[\\/]/)
        if (segments.some((s) => s === '..' || s === '')) {
          sendJson(res, 400, { error: 'path must not contain .. or empty segments' })
          return
        }
        if (!segmentsAllowed(segments, true)) {
          sendJson(res, 403, { error: 'this file type or location is not readable here' })
          return
        }
        const root = realRoot()
        if (!root) {
          sendJson(res, 404, { error: 'agent folder does not exist' })
          return
        }
        let real
        try { real = fs.realpathSync(path.join(root, ...segments)) } catch {
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        const within = path.relative(root, real)
        if (!within || within.startsWith('..') || path.isAbsolute(within)) {
          sendJson(res, 403, { error: 'path resolves outside the agent folder' })
          return
        }
        // The resolved name gets the same allowlist: a symlink INSIDE the
        // folder must not launder a dot-folder or credential file.
        if (!segmentsAllowed(within.split(path.sep), true)) {
          sendJson(res, 403, { error: 'this file type or location is not readable here' })
          return
        }
        let st
        try { st = fs.statSync(real) } catch {
          sendJson(res, 404, { error: 'no such file' })
          return
        }
        if (!st.isFile()) {
          sendJson(res, 400, { error: 'not a file' })
          return
        }
        const len = Math.min(st.size, MAX_FILE_BYTES)
        const buf = Buffer.alloc(len)
        const fd = fs.openSync(real, 'r')
        try { fs.readSync(fd, buf, 0, len, 0) } finally { fs.closeSync(fd) }
        sendJson(res, 200, {
          path: segments.join('/'),
          name: segments[segments.length - 1],
          size: st.size,
          mtimeISO: st.mtime.toISOString(),
          truncated: st.size > MAX_FILE_BYTES,
          text: buf.toString('utf8'),
        })
        return
      },
    },
  ]
}

module.exports = { createRoutes, ALLOWED_EXT, MAX_FILE_BYTES }
