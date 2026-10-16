#!/usr/bin/env node
// test-memory-at-rest.mjs -- the memory DB is owner-only on disk.
//
// WHY THIS EXISTS. memory.db shipped as 0644 inside a 0755 directory, holding
// everything the agent knows about its user in plaintext SQLite. Meanwhile
// memory/service.mjs sets `PRAGMA secure_delete = ON` to zero freed pages and
// runs wal_checkpoint(TRUNCATE) after a delete so the -wal cannot keep the
// bytes -- real care about residue, spent on a file any process on the machine
// could open and read whole. The care and the mode disagreed, and the mode is
// what decided. (Found 2026-08-04 while checking a different claim.)
//
// This is NOT the same class as the credential blobs. Those are
// safeStorage-encrypted before they are written, so their file mode is defence
// in depth and losing it costs little. This DB is plaintext. Here the mode IS
// the protection, which is why it gets its own test instead of a comment.
//
// The three things that can silently rot, each asserted below:
//   1. the main DB file
//   2. the -wal and -shm siblings -- SQLite creates them itself, and the -wal
//      holds recently written rows verbatim, so a 0600 db beside a 0644 -wal
//      protects nothing
//   3. EXISTING installs -- a create-time-only mode would leave every file
//      already on disk at 0644 forever, which is the whole population that
//      needs the fix
import { mkdtempSync, mkdirSync, chmodSync, statSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
function assert(cond, label, detail) {
  if (cond) { pass++; console.log(`  ok   ${label}`) } else { fail++; console.log(`  FAIL ${label}${detail === undefined ? '' : ` -- ${detail}`}`) }
}
const mode = (p) => statSync(p).mode & 0o777
const oct = (p) => '0' + mode(p).toString(8)

// POSIX modes only, said out loud rather than skipped in silence. What decides
// is not the platform NAME but whether chmod actually sticks on this host --
// fs.chmod maps only the read-only bit on Windows (so these assertions can
// never hold there; the profile's inherited ACL is what bounds access, weaker
// than 0600 and asserted by nothing today), and it is equally a no-op on a
// FAT/exFAT/SMB mount under any OS. So: probe the capability (P1,
// design-0023). A 3-line chmod-then-stat on a tmp file is cheaper than being
// wrong about which hosts can run this, and it makes the file run on Linux --
// where it does hold -- without anyone adding a platform to a list.
function chmodIsHonored() {
  let dir = null
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sched-atrest-probe-'))
    const f = path.join(dir, 'probe')
    writeFileSync(f, 'x')
    chmodSync(f, 0o600)
    return (statSync(f).mode & 0o777) === 0o600
  } catch {
    return false
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* tmp */ } }
  }
}

if (!chmodIsHonored()) {
  console.log('memory at rest:')
  console.log('  n/a  0600/0700 modes -- chmod is not honored on this host (Windows maps only the read-only bit; so do FAT/exFAT/SMB mounts). What bounds access there is the profile ACL: weaker than 0600, and asserted by nothing today.')
  console.log(`SKIP: memory-at-rest 0600/0700 file modes -- chmod does not stick on this filesystem (${process.platform}); NOT a pass`)
  console.log('\n0 passed, 0 failed (capability probe: chmod not honored)')
  process.exitCode = 0
} else {
  console.log('memory at rest:')

  const home = path.join(mkdtempSync(path.join(os.tmpdir(), 'sched-atrest-')), 'data')
  process.env.AGENT_DATA_HOME = home
  process.env.SCHEHERAZADE_MEMORY_DB = path.join(home, 'memory.db')
  const DB = process.env.SCHEHERAZADE_MEMORY_DB

  const { initDb } = await import('../memory/service.mjs')

  // ── 1+2. a fresh DB, and the siblings WAL mode creates ──────────────────
  //
  // THE HANDLE STAYS OPEN for the sibling checks, and that is the point.
  // close() checkpoints and unlinks -wal/-shm, so a test that closed first
  // would find no siblings and pass by having nothing to look at. The window
  // where they exist on disk is exactly the window a live agent runs in --
  // which is when it matters. (First draft of this file closed first and
  // reported them missing; the test caught its own wrong lifecycle moment.)
  const live = initDb()

  assert(mode(DB) === 0o600, `a fresh memory.db is 0600 (got ${oct(DB)})`)
  assert(mode(home) === 0o700, `its directory is 0700 (got ${oct(home)})`)

  for (const suffix of ['-wal', '-shm']) {
    const f = `${DB}${suffix}`
    assert(existsSync(f), `memory.db${suffix} exists while the DB is open (if this fails the next assert is vacuous, not passing)`)
    if (existsSync(f)) {
      assert(mode(f) === 0o600, `memory.db${suffix} is 0600 (got ${oct(f)}) -- the -wal holds recent rows verbatim`)
    }
  }
  // A restored DB can contain the author column and pre-backfill rows.
  live.prepare("INSERT INTO journal_entries (date, body, created_at, updated_at, author) VALUES (?, ?, ?, ?, NULL)")
    .run('2026-01-01', 'restored journal', 'then', 'then')
  live.close()
  const restored = initDb()
  assert(restored.prepare('SELECT author FROM journal_entries WHERE date = ?').get('2026-01-01').author !== null,
    'existing author column still backfills restored null rows')
  restored.close()

  // ── 3. the migration case: an install that already exists at 0644 ───────
  // This is the assertion that matters most. Every install created before
  // 2026-08-04 is in exactly this state, and a create-time-only fix reaches
  // none of them.
  chmodSync(DB, 0o644)
  chmodSync(home, 0o755)
  assert(mode(DB) === 0o644, 'fixture: loosened back to 0644 to simulate an existing install')

  initDb().close()

  assert(mode(DB) === 0o600, `reopening an existing 0644 DB tightens it to 0600 (got ${oct(DB)})`)
  assert(mode(home) === 0o700, `...and its directory back to 0700 (got ${oct(home)})`)

  // ── 4. hardening must never cost the user their memory ──────────────────
  // The service is hardening, not a gate: a chmod that fails must log and
  // carry on, because a user who cannot open their memory is worse off than
  // one whose file mode is loose.
  //
  // NOT asserted by execution, and said plainly rather than faked: as the
  // OWNER of these inodes there is no reliable POSIX way to make chmod fail
  // on demand (a read-only parent directory blocks creating and unlinking
  // entries, not chmod of an existing file). A test that set that up and
  // watched initDb succeed would be asserting nothing while reading as
  // coverage -- the exact shape this suite already got burned by.
  //
  // So the fail-soft property is pinned at the source instead, which is
  // honest about being a weaker check than the ones above.
  const svcSrc = await import('node:fs').then((m) => m.readFileSync(new URL('../memory/service.mjs', import.meta.url), 'utf8'))
  const fn = svcSrc.slice(svcSrc.indexOf('function hardenDbFiles'), svcSrc.indexOf('function initDb'))
  assert(fn.length > 0, 'located hardenDbFiles in memory/service.mjs')
  assert((fn.match(/catch \(err\)/g) || []).length >= 2, 'every chmod in hardenDbFiles is wrapped -- the directory and the files each catch')
  assert(!/throw/.test(fn), 'hardenDbFiles never throws: losing the tightening must not cost the user their memory service')
  assert(/win32/.test(fn), 'hardenDbFiles returns early on Windows rather than logging a failure per file every boot')

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exitCode = fail === 0 ? 0 : 1
}
