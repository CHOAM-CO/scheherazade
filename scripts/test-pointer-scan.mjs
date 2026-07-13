#!/usr/bin/env node
// test-pointer-scan.mjs -- adversarial fixtures for memory/pointer-scan.cjs.
//
// The scanner's entire job is to look at other tools' local files WITHOUT
// touching a secret and WITHOUT copying content. So these tests are written as
// attacks, not as happy paths: plant real credential-shaped files, plant a
// symlink escape, plant a huge directory, and assert the scanner refuses.
//
// A pointer index that leaks one API key is worse than no pointer index.
//
// Run: node scripts/test-pointer-scan.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { scanPointers, defaultSources, isDenied, isInsideRoot, looksSecret, looksUnknownCredential } = require('../memory/pointer-scan.cjs')

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// A fake home with the real shapes: a legit memory file, and a minefield of
// credentials laid out exactly where the real tools keep them.
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-ptr-'))
  const claude = path.join(home, '.claude')
  const codex = path.join(home, '.codex')
  fs.mkdirSync(claude, { recursive: true })
  fs.mkdirSync(codex, { recursive: true })

  // Legit, indexable.
  fs.writeFileSync(path.join(claude, 'CLAUDE.md'), '# Project rules\nsome body text that must NOT be indexed\n## Deploy\nmore secret-ish body\n')
  fs.writeFileSync(path.join(codex, 'AGENTS.md'), '# Codex agents\n')

  // THE MINEFIELD -- every one of these must be refused.
  fs.writeFileSync(path.join(claude, '.credentials.json'), '{"accessToken":"sk-ant-LEAKED"}')
  fs.writeFileSync(path.join(codex, 'auth.json'), '{"OPENAI_API_KEY":"sk-LEAKED"}')
  fs.writeFileSync(path.join(claude, 'my-token.md'), '# has token in the name')
  fs.writeFileSync(path.join(claude, 'secrets.md'), '# secrets')
  fs.writeFileSync(path.join(claude, 'server.pem'), 'PRIVATE KEY')
  fs.writeFileSync(path.join(claude, '.env'), 'API_KEY=LEAKED')
  const sshDir = path.join(claude, '.ssh')
  fs.mkdirSync(sshDir)
  fs.writeFileSync(path.join(sshDir, 'notes.md'), '# innocuous name inside a forbidden dir')

  return home
}

const sourcesFor = (home) => defaultSources(home).filter((s) => s.tool !== 'claude-desktop')

console.log('pointer-scan adversarial fixtures\n')

// ── 1. The minefield: no secret is ever indexed ─────────────────────────────
{
  const home = makeHome()
  const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const paths = pointers.map((p) => p.path)
  const blob = JSON.stringify(pointers)

  check('indexes the legit memory file', paths.some((p) => p.endsWith('CLAUDE.md')), paths.join(','))
  check('indexes the legit codex file', paths.some((p) => p.endsWith('AGENTS.md')), paths.join(','))

  check('REFUSES .credentials.json', !paths.some((p) => p.includes('.credentials')), paths.join(','))
  check('REFUSES codex auth.json', !paths.some((p) => p.includes('auth.json')), paths.join(','))
  check('REFUSES a file with "token" in the name', !paths.some((p) => p.includes('my-token')), paths.join(','))
  check('REFUSES secrets.md', !paths.some((p) => p.includes('secrets')), paths.join(','))
  check('REFUSES a .pem', !paths.some((p) => p.endsWith('.pem')), paths.join(','))
  check('REFUSES .env', !paths.some((p) => p.endsWith('.env')), paths.join(','))
  check('REFUSES anything under .ssh/, however innocent its name', !paths.some((p) => p.includes('.ssh')), paths.join(','))

  // The load-bearing assertion: no secret VALUE can appear anywhere in the
  // output, by any route -- filename, topic, or otherwise.
  check('no leaked secret value appears ANYWHERE in the output', !blob.includes('LEAKED'), 'a secret reached the index')
}

// ── 2. Content is not copied -- only headings (WHERE, never WHAT) ───────────
{
  const home = makeHome()
  const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const claudeMd = pointers.find((p) => p.path.endsWith('CLAUDE.md'))
  const blob = JSON.stringify(pointers)
  check('a topic label IS captured (the index is useful)', claudeMd && claudeMd.topic.includes('Project rules'), JSON.stringify(claudeMd))
  check('body text is NOT captured (the index is not a copy)', !blob.includes('some body text'), 'file body leaked into the index')
  check('second-level body is NOT captured', !blob.includes('more secret-ish body'), 'file body leaked into the index')
}

// ── 3. Symlink escape: a link inside an allowed root pointing OUT ───────────
//    DENY only sees the link's own innocent path, so containment on the
//    RESOLVED target is what has to stop this.
{
  const home = makeHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-outside-'))
  fs.writeFileSync(path.join(outside, 'stolen.md'), '# should never be reachable')
  try {
    fs.symlinkSync(path.join(outside, 'stolen.md'), path.join(home, '.claude', 'innocent.md'))
    const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
    const paths = pointers.map((p) => p.path)
    check('REFUSES a symlink escaping the allowed root', !paths.some((p) => p.includes('innocent.md')), paths.join(','))
  } catch (err) {
    check('symlink escape test ran', false, `could not create symlink: ${err.message}`)
  }
}

// ── 4. Containment helper: the classic startsWith bug ───────────────────────
{
  check('isInsideRoot: exact root is inside', isInsideRoot('/home/u/.claude', '/home/u/.claude'))
  check('isInsideRoot: child is inside', isInsideRoot('/home/u/.claude/x.md', '/home/u/.claude'))
  check('isInsideRoot: sibling with shared prefix is NOT inside (startsWith bug)', !isInsideRoot('/home/u/.claude-evil/x.md', '/home/u/.claude'))
  check('isInsideRoot: parent is NOT inside', !isInsideRoot('/home/u', '/home/u/.claude'))
}

// ── 5. isDenied is case-insensitive (a secret named AUTH.JSON is a secret) ──
{
  check('isDenied: AUTH.JSON (uppercase)', isDenied('/home/u/.codex/AUTH.JSON'))
  check('isDenied: Secret in a mid-path dir', isDenied('/home/u/.claude/Secrets/notes.md'))
  check('isDenied: a plain md is allowed', !isDenied('/home/u/.claude/CLAUDE.md'))
}

// ── 6. Coverage is reported even for sources that found NOTHING ─────────────
//    "we looked and found nothing" is information the user is owed; an empty
//    section with no explanation reads as a bug.
{
  const home = makeHome()
  const { coverage } = scanPointers({ homedir: home, sources: defaultSources(home) })
  const desktop = coverage.find((c) => c.tool === 'claude-desktop')
  check('coverage row exists for a source with zero hits', Boolean(desktop), JSON.stringify(coverage))
  check('coverage row carries an honest note', Boolean(desktop && desktop.note && desktop.note.length > 0))
  check('coverage reports found=0 rather than omitting the source', desktop && desktop.found === 0, JSON.stringify(desktop))
  check('every configured source gets a coverage row', coverage.length === 3, JSON.stringify(coverage.map((c) => c.tool)))
}

// ── 7. A missing root must not throw (tool simply isn't installed) ──────────
{
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-empty-'))
  let threw = false
  let result = null
  try { result = scanPointers({ homedir: empty, sources: defaultSources(empty) }) } catch { threw = true }
  check('missing tool dirs do not throw', !threw)
  check('missing tool dirs yield zero pointers, not a crash', result && result.pointers.length === 0)
}


// ── 8. RED TEAM 2026-07-13: a secret inside a markdown HEADING ─────────────
//    The channel my first fixtures were blind to. I had classified headings as
//    "metadata, not content" and only asserted that BODY text never leaked --
//    so a heading was free to carry a key straight into the DB and the API
//    response, labelled "topic". The category was the blind spot, not the code.
{
  const home = makeHome()
  const md = path.join(home, '.claude', 'notes.md')
  fs.writeFileSync(md, [
    '# sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA',   // pasted key as a heading
    '# ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',      // github token as a heading
    '# Bearer abcdefghijklmnopqrstuvwxyz012345',
    '# Actually Fine Heading',
  ].join('\n'))
  const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const blob = JSON.stringify(pointers)
  check('heading with an sk- key is DROPPED', !blob.includes('sk-ant-api03'), blob)
  check('heading with a github token is DROPPED', !blob.includes('ghp_'), blob)
  check('heading with a Bearer token is DROPPED', !blob.includes('Bearer abcdef'), blob)
  const row = pointers.find((p) => p.path.endsWith('notes.md'))
  check('the innocent heading in the same file SURVIVES', row && row.topic.includes('Actually Fine Heading'), JSON.stringify(row))
}

// ── 9. RED TEAM: a secret-shaped FILENAME ─────────────────────────────────
//    The path is persisted verbatim, so the filename is its own leak channel.
{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.claude', 'sk-ant-api03-BBBBBBBBBBBBBBBBBBBB.md'), '# hi')
  const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const blob = JSON.stringify(pointers)
  check('secret-shaped FILENAME is never indexed', !blob.includes('sk-ant-api03'), blob)
}

// ── 10. RED TEAM: hardlink escape ─────────────────────────────────────────
//    A hardlink has no target path -- realpathSync reports the in-root name --
//    so containment cannot see that the inode is also ~/.ssh/id_rsa. Link count
//    is the only signal we get.
{
  const home = makeHome()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hard-'))
  const sensitive = path.join(outside, 'private-thing')
  fs.writeFileSync(sensitive, '# Innocent Looking Heading\nHARDLINKED_SECRET_BODY\n')
  try {
    fs.linkSync(sensitive, path.join(home, '.claude', 'harmless.md'))
    const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
    const blob = JSON.stringify(pointers)
    check('hardlinked file is NOT indexed (nlink > 1)', !blob.includes('harmless.md'), blob)
    check('hardlinked content never reaches the index', !blob.includes('HARDLINKED_SECRET'), blob)
  } catch (err) {
    check('hardlink test ran', false, `could not hardlink: ${err.message}`)
  }
}

// ── 11. looksSecret unit shapes ───────────────────────────────────────────
{
  check('looksSecret: sk- key', looksSecret('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA'))
  check('looksSecret: JWT', looksSecret('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'))
  check('looksSecret: AWS key id', looksSecret('AKIAIOSFODNN7EXAMPLE'))
  check('looksSecret: long hex blob', looksSecret('a'.repeat(40)))
  check('looksSecret: ordinary prose is NOT a secret', !looksSecret('# Deploy notes for the staging server'))
  check('looksSecret: ordinary path is NOT a secret', !looksSecret('/Users/x/.claude/CLAUDE.md'))
}

// ── 12. FAILURE DIRECTION 2026-07-13 (fleet class B): the UNSEEN shape ─────
//    SECRET_SHAPES is a denylist of shapes already seen, so on a shape nobody has
//    seen it returns false and the heading ships. The remedy is not more shapes --
//    the hand writing the list is the blind hand -- it is to make this surface's
//    SILENCE mean "drop" instead of "publish". These are credential formats that
//    match NONE of SECRET_SHAPES on purpose.
{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.claude', 'unseen.md'), [
    '# corp_tok_9f3k2m4x8q7w1e5r6t0y',        // invented internal format
    '# hunter2correcthorsebattery99',          // a pasted password, no known prefix
    '# db://admin:Pa55w0rdLongEnough@host',    // credential inside a connstring
    '# Deploy notes for the staging server',   // ordinary prose: must SURVIVE
  ].join('\n'))
  const { pointers } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const blob = JSON.stringify(pointers)
  const row = pointers.find((p) => p.path.endsWith('unseen.md'))

  check('UNSEEN internal token format is dropped', !blob.includes('corp_tok_9f3k'), blob)
  check('UNSEEN pasted password is dropped', !blob.includes('hunter2correct'), blob)
  check('UNSEEN credential in a connstring is dropped', !blob.includes('Pa55w0rd'), blob)
  check('the file is STILL indexed (we lose a label, never the pointer)', Boolean(row), blob)
  check('ordinary prose in the same file SURVIVES', row && row.topic.includes('Deploy notes'), JSON.stringify(row))
}

// ── 13. looksUnknownCredential: the false-drop cost is bounded ─────────────
//    Over-strict on purpose, so state the exact cost: a long alphanumeric token in
//    a heading loses its LABEL. Prose, paths and short versions must not trip it.
{
  check('unknown: long digit+letter run trips', looksUnknownCredential('# corp_tok_9f3k2m4x8q7w1e5r6t0y'))
  check('unknown: base64-ish blob trips', looksUnknownCredential('aGVsbG8gd29ybGQgMTIzNDU2Nzg5MA'))
  check('unknown: plain prose does NOT trip', !looksUnknownCredential('Deploy notes for the staging server'))
  check('unknown: a letters-only path does NOT trip', !looksUnknownCredential('/Users/x/.claude/CLAUDE.md'))
  check('unknown: short versioned heading does NOT trip', !looksUnknownCredential('Release 2026-07-13 rc1'))
  check('unknown: korean prose does NOT trip', !looksUnknownCredential('배포 노트 2026년 7월'))
  check('ACCEPTED COST: a long alnum identifier loses its label', looksUnknownCredential('commit 94cc732a75d352233c878ee2bd8'))
}

// ── 14. A SILENT drop is still a silent failure ───────────────────────────
//    Dropping the heading is safe, but a suppression the user cannot see is
//    indistinguishable from a bug -- and "cannot fail loudly" is the whole class.
//    So the count is surfaced. Loud and cheap beats safe and quiet.
{
  const home = makeHome()
  fs.writeFileSync(path.join(home, '.claude', 'leaky.md'), '# sk-ant-api03-CCCCCCCCCCCCCCCCCCCC\n# Fine Heading\n')
  const { coverage } = scanPointers({ homedir: home, sources: sourcesFor(home) })
  const cc = coverage.find((c) => c.tool === 'claude-code')
  check('coverage REPORTS suppressed headings', cc && cc.suppressed === 1, JSON.stringify(cc))

  const clean = makeHome()
  const { coverage: cov2 } = scanPointers({ homedir: clean, sources: sourcesFor(clean) })
  const cc2 = cov2.find((c) => c.tool === 'claude-code')
  check('a clean scan reports suppressed: 0, not undefined', cc2 && cc2.suppressed === 0, JSON.stringify(cc2))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
