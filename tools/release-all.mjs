#!/usr/bin/env node
// tools/release-all.mjs -- one commit, three platforms, one release.
//
// WHY THIS FILE EXISTS. A Scheherazade release is three builds on three
// machines, and until now it was three runbook sections a human executed by
// hand over ssh, each with its own trap, none of them checked. What that
// produced is on the record: v0.2.20's "x86_64" Linux asset was built on this
// arm64 Mac, so `file` on its AppRun says aarch64 and its bundled natives were
// @koromix/koffi-darwin-arm64 and friends -- an artifact no x86_64 Linux can
// execute at all, published, downloaded, and only caught days later. Nothing
// in the procedure could have caught it, because the procedure was prose.
//
// So the procedure is a program. It refuses to build on the wrong host (via
// npm run dist*'s own assert-platform gate), it opens every artifact it
// collects and says what is actually inside, and it will not publish a set it
// has not verified.
//
// THE THREE LANES, and the traps each one is written around:
//
//   mac    -- here. `npm test` then `npm run dist`. predist/postdist run
//             tools/test-packaging.mjs fail-closed, which is the only closure
//             gate this project has on what ships.
//
//   win    -- ON the Windows box, never cross-built. `git archive` -> scp ->
//             a generated .cmd -> npm ci -> npm run dist:win.
//             TRAP 1: in a .cmd file, `npm` is npm.cmd, and cmd.exe's batch
//             interpreter TRANSFERS control to another batch file instead of
//             calling it -- so a bare `npm ci` ends the script there and every
//             line after it silently never runs. Every npm invocation below is
//             `call npm`.
//             TRAP 2: a shell pipe inside the ssh command string is interpreted
//             by the REMOTE cmd.exe, not by the local shell. `ssh magi-win
//             "... | tail"` on 2026-09-02 exited 0 with npm ci never having
//             run. Nothing here pipes on the remote side.
//             TRAP 3: anything backgrounded dies with the ssh session. Every
//             remote step is foreground, and ServerAliveInterval keeps the
//             session up across the long silent stretch of `npm ci` (which
//             used to drop the connection with exit 255).
//
//   linux  -- in WSL2 (Ubuntu) on the same Windows box; /root/schz.
//             TRAP 1: never feed the script over stdin. `ssh box "wsl ... bash"
//             < script` hands git and npm the same stdin and they eat it. The
//             script is scp'd to the Windows side and run by path, and its
//             first line is `exec </dev/null` so nothing downstream can read
//             the terminal either.
//             TRAP 2: that tree has NO GitHub credentials. Source is delivered
//             as a `git bundle` -- a single file, scp'd to the Windows side and
//             fetched from /mnt/c/... -- not cloned.
//             TRAP 3: `npm install` there leaves package-lock.json dirty, and a
//             dirty lockfile blocks the next checkout. `git checkout --` it
//             first, every time.
//             Artifacts come back by cp to /mnt/c/Users/magi/ and then scp,
//             because scp cannot reach inside the WSL filesystem.
//
// WHAT IT REFUSES TO DO. --publish is OFF by default: without it the driver
// prints the exact `gh` command and the asset list and stops. Publishing is a
// human's call, every time. And the win/linux legs are never run from a
// rehearsal: they touch a shared box, so `--dry-run` prints every ssh/scp
// command instead.
//
// Usage:
//   node tools/release-all.mjs --tag v0.3.0                 # build all 3, verify, print the gh command
//   node tools/release-all.mjs --only mac --allow-dirty     # rehearse the mac leg on a working tree
//   node tools/release-all.mjs --dry-run --tag v0.3.0       # print every command, run nothing
//   node tools/release-all.mjs --allow-dirty --rehearse-remote --only win --only linux   # real boxes, rehearsal dirs
//   node tools/release-all.mjs --tag v0.3.0 --publish --notes docs/release-notes-v0.3.0.md
//   node tools/release-all.mjs --tag v0.3.0 --publish --clobber --notes <file>   # release already exists

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const RELEASE_DIR = path.join(ROOT, 'release')
const PRODUCT = (pkg.build && pkg.build.productName) || 'Scheherazade'

// The public feed every installed copy polls (updater.cjs UPDATE_OWNER /
// UPDATE_RELEASES_REPO, build.publish). Derived from build.publish so this
// file cannot drift from what the app actually checks.
const ghPublish = (pkg.build.publish || []).find((p) => p && p.provider === 'github') || {}
const RELEASE_REPO = `${ghPublish.owner || 'Mino-is-me'}/${ghPublish.repo || 'scheherazade-releases'}`

// The Windows box, and the WSL2 tree on it. One ssh alias reaches both.
const WIN_HOST = process.env.SCHZ_WIN_HOST || 'magi-win'
const WIN_USER_DIR = 'C:\\Users\\magi'
const WIN_BUILD_ROOT = `${WIN_USER_DIR}\\sch-build`
const WSL_DISTRO = process.env.SCHZ_WSL_DISTRO || 'Ubuntu'
const WSL_TREE = '/root/schz'
// scp needs forward slashes; cmd.exe needs backslashes. Both, spelled once.
const winScpPath = (winPath) => winPath.replace(/\\/g, '/')

// REHEARSAL, set by --rehearse-remote. Every name that lands on the shared box
// -- the build directory, the bundle, the WSL script, the branch it checks out
// -- is derived from this ONE slug, so a rehearsal cannot collide with, or
// overwrite, a real run's files. Prefix and not suffix on purpose: everything
// belonging to a rehearsal sorts together on the box, and `rmdir` cleanup can
// never be aimed at a release directory by a typo in a tag.
let REHEARSE = false
const remoteSlug = (tag) => (REHEARSE ? `rehearsal-${tag}` : tag)

// npm ci on the Windows box goes silent for minutes at a stretch and used to
// drop the connection with exit 255. Keepalives, generously.
const SSH_OPTS = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=240']

// ── argument parsing ────────────────────────────────────────────────────────

function usage() {
  console.log(`node tools/release-all.mjs [options]

  --tag vX.Y.Z      the release tag. Default v${pkg.version} (package.json).
                    It must always equal package.json's version -- a tag that
                    disagrees with the version baked into the artifacts is the
                    version illusion, and no flag relaxes that check.
  --only <lane>     mac | win | linux. Repeatable. Default: all three.
  --dry-run         print every build / ssh / scp / gh command, run nothing.
  --allow-dirty     rehearsal: downgrade the branch / clean-tree / tag
                    preflight to warnings. The artifacts it produces are NOT
                    releasable; --publish refuses to run with it.
  --publish         actually create the GitHub release on ${RELEASE_REPO}.
                    OFF by default; without it the exact gh command is printed.
  --clobber         if the release already exists, upload assets over it
                    (gh release upload --clobber) instead of refusing.
  --rehearse-remote with --allow-dirty ONLY: actually run the win and linux
                    legs on the shared box, but into rehearsal locations --
                    C:\\Users\\magi\\sch-build\\rehearsal-<tag>\\ and a WSL branch
                    named rehearsal-<tag> instead of the release ones.
                    Artifacts still come back to release/ and get the same
                    verification rows. Without it, --allow-dirty never touches
                    the shared box at all.
  --verify-only     build nothing; open whatever is already in release/ and
                    check it. This is how a leg someone else ran on the boxes
                    gets checked here, and it is the only way the win/linux
                    verification rows can be exercised without a shared box.
  --notes <file>    release notes file (required by --publish).
  --keep-remote     do not delete the remote build directory afterwards.
  --help`)
}

function parseArgs(argv) {
  const o = { tag: null, only: [], dryRun: false, allowDirty: false, publish: false, clobber: false, notes: null, keepRemote: false, verifyOnly: false, rehearseRemote: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const inline = (flag) => (a.startsWith(`${flag}=`) ? a.slice(flag.length + 1) : null)
    const take = (v) => (v !== null ? v : argv[++i])
    if (a === '--help' || a === '-h') o.help = true
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--allow-dirty') o.allowDirty = true
    else if (a === '--publish') o.publish = true
    else if (a === '--clobber') o.clobber = true
    else if (a === '--keep-remote') o.keepRemote = true
    else if (a === '--verify-only') o.verifyOnly = true
    else if (a === '--rehearse-remote') o.rehearseRemote = true
    else if (a === '--tag' || a.startsWith('--tag=')) o.tag = String(take(inline('--tag')) || '')
    else if (a === '--notes' || a.startsWith('--notes=')) o.notes = String(take(inline('--notes')) || '')
    else if (a === '--only' || a.startsWith('--only=')) {
      const v = String(take(inline('--only')) || '')
      if (!['mac', 'win', 'linux'].includes(v)) { console.error(`release-all: --only takes mac | win | linux, got ${JSON.stringify(v)}`); process.exit(2) }
      o.only.push(v)
    } else { console.error(`release-all: unknown argument ${JSON.stringify(a)}`); usage(); process.exit(2) }
  }
  return o
}

// ── logging: everything this run said, on disk, next to the artifacts ───────

let logStream = null
function log(line = '') {
  const s = String(line)
  console.log(s)
  if (logStream) { try { fs.appendFileSync(logStream, s + '\n') } catch { /* the log is a record, never the gate */ } }
}
function header(t) { log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`) }

let failures = 0
let checks = 0
function ok(name, cond, detail = '') {
  checks++
  if (cond) log(`  ok    ${name}`)
  else { failures++; log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
  return !!cond
}

// ── command execution ───────────────────────────────────────────────────────
// Every external command in this file goes through here, so --dry-run is a
// property of the runner rather than something each leg has to remember.

let DRY = false
// A path inside the repo reads better relative; one in /var/folders reads as
// nonsense relative ("../../../../var/..."). Show each as what it is.
const shortPath = (p) => {
  const rel = path.relative(ROOT, p)
  return rel.startsWith('..') ? p : rel
}
function show(cmd, args, opts = {}) {
  const shown = [cmd, ...args].map((a) => (/[\s"']/.test(a) ? JSON.stringify(a) : a)).join(' ')
  return opts.cwd && opts.cwd !== ROOT ? `(cd ${opts.cwd}) ${shown}` : shown
}
// Streamed, not buffered, and TEE'd. A four-minute electron-builder run with
// no visible output is unusable, and a release log that carries only the
// driver's own commentary -- not what npm ci, electron-builder or the remote
// build actually said -- is not evidence of anything. So every child's stdout
// and stderr go to this terminal AND to release/release-all-<tag>.log as they
// arrive. That is also why this layer is async: spawnSync cannot tee.
function run(cmd, args, opts = {}) {
  log(`  $ ${show(cmd, args, opts)}`)
  if (DRY && !opts.alwaysRun) return Promise.resolve({ status: 0, dry: true })
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env || process.env,
    })
    let tail = ''
    const sink = (stream) => (buf) => {
      const text = buf.toString()
      stream.write(text)
      if (logStream) { try { fs.appendFileSync(logStream, text) } catch { /* record only */ } }
      // Keep the last few KB so a failure can name its own last words instead
      // of "exit 1".
      tail = (tail + text).slice(-8192)
    }
    child.stdout.on('data', sink(process.stdout))
    child.stderr.on('data', sink(process.stderr))
    child.on('error', (err) => resolve({ status: -1, tail: err.message }))
    child.on('close', (status) => resolve({ status, tail }))
  })
}
// Quiet capture for the preflight questions -- these are queries, not steps,
// and they run even under --dry-run because a dry run that cannot see the tree
// state is a dry run of nothing.
function q(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
async function mustRun(cmd, args, opts = {}) {
  const r = await run(cmd, args, opts)
  if (r.dry) return r
  if (r.status !== 0) {
    const why = String(r.tail || '').trim().split('\n').slice(-6).join('\n')
    throw new Error(`command failed (exit ${r.status}): ${show(cmd, args, opts)}${why ? `\n${why}` : ''}`)
  }
  return r
}

// ── electron-builder's latest*.yml, read without a YAML dependency ──────────
// These files are machine-generated and have exactly one shape. A real YAML
// parser would be a dependency this repo does not have; a regex over a
// hand-written file would be a guess. This is neither: it reads the four keys
// electron-updater itself reads, and says so when a key is missing rather than
// returning a plausible undefined.
function parseLatestYml(text) {
  const out = { version: null, path: null, sha512: null, files: [] }
  const lines = text.split(/\r?\n/)
  let cur = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    let m
    if ((m = /^version:\s*(.+)$/.exec(line))) out.version = m[1].trim().replace(/^['"]|['"]$/g, '')
    else if ((m = /^path:\s*(.+)$/.exec(line))) out.path = m[1].trim().replace(/^['"]|['"]$/g, '')
    else if ((m = /^sha512:\s*(.+)$/.exec(line))) out.sha512 = m[1].trim()
    else if (/^\s+-\s+url:\s*/.test(line)) {
      cur = { url: line.replace(/^\s+-\s+url:\s*/, '').trim().replace(/^['"]|['"]$/g, ''), sha512: null, size: null }
      out.files.push(cur)
    } else if (cur && (m = /^\s+sha512:\s*(.+)$/.exec(line))) cur.sha512 = m[1].trim()
    else if (cur && (m = /^\s+size:\s*(\d+)\s*$/.exec(line))) cur.size = Number(m[1])
  }
  return out
}
const sha512b64 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64')

// `file(1)`'s answer, first line, or null when the artifact is not here.
function fileHeader(p) {
  if (!fs.existsSync(p)) return null
  const r = q('file', ['-b', p])
  return r.code === 0 ? r.out.split('\n')[0] : null
}

// ── artifact naming, derived from build config (never hand-typed twice) ─────

function artifactNames(version) {
  const winName = ((pkg.build.win || {}).artifactName || 'Scheherazade-Setup-${version}.exe').replace(/\$\{version\}/g, version)
  const linuxName = ((pkg.build.linux || {}).artifactName || 'Scheherazade-${version}-x86_64.AppImage')
    .replace(/\$\{version\}/g, version).replace(/\$\{arch\}/g, 'x86_64')
  return {
    mac: [`${PRODUCT}-${version}-arm64.dmg`, `${PRODUCT}-${version}-arm64.dmg.blockmap`, 'latest-mac.yml'],
    win: [winName, `${winName}.blockmap`, 'latest.yml'],
    linux: [linuxName, 'latest-linux.yml'],
  }
}

// ── preflight ───────────────────────────────────────────────────────────────

function preflight(opts, tag) {
  header(`preflight -- ${tag} on ${RELEASE_REPO}`)
  const version = tag.replace(/^v/, '')

  // NEVER relaxed, not even by --allow-dirty. Everything downstream -- the
  // artifact filenames, the version inside the staged asar, the yml the
  // updater reads -- comes from package.json. A tag that disagrees produces a
  // release whose assets are named for one version and behave as another.
  if (version !== pkg.version) {
    log(`  FAIL  --tag ${tag} does not match package.json version ${pkg.version}`)
    log('        Bump package.json (and rebuild) or pass the matching tag. This one is never waived:')
    log('        the version is baked into every artifact name and into the staged asar.')
    process.exit(1)
  }
  ok(`--tag ${tag} matches package.json version ${pkg.version}`, true)

  const soft = (name, cond, detail) => {
    checks++
    if (cond) { log(`  ok    ${name}`); return true }
    if (opts.allowDirty) { log(`  warn  ${name}${detail ? ` -- ${detail}` : ''}  (allowed by --allow-dirty; NOT releasable)`); return false }
    failures++; log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`); return false
  }

  const branch = q('git', ['rev-parse', '--abbrev-ref', 'HEAD']).out
  soft(`HEAD is on main (it is on ${branch})`, branch === 'main',
    'a release cut from a side branch produces artifacts nobody can reproduce from the default branch')

  const dirty = q('git', ['status', '--porcelain']).out
  soft('the working tree is clean', dirty === '',
    `${dirty.split('\n').filter(Boolean).length} modified/untracked path(s) would be built into the artifacts`)

  const tagSha = q('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`]).out
  soft(`the tag ${tag} exists locally`, !!tagSha, 'git tag -a ' + tag)

  const head = q('git', ['rev-parse', 'HEAD']).out
  if (tagSha) soft(`the tag points at HEAD (${head.slice(0, 8)})`, tagSha === head, `tag is ${tagSha.slice(0, 8)}`)

  const remote = q('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`]).out
  soft(`the tag is pushed to origin`, remote.includes(tag),
    'gh release create tags the remote default branch head when the tag is absent -- push the tag FIRST (this is the 0.1.9 lesson)')

  log(`\n  HEAD ${head}`)
  log(`  release dir ${RELEASE_DIR}`)
  return { version, head }
}

// ── lane: mac (this machine) ────────────────────────────────────────────────

async function legMac() {
  header('mac lane -- this machine (darwin/arm64)')
  log('  npm test first: the packaging gate that runs inside npm run dist checks what the build')
  log('  produced, not whether the code works. Both, in that order, or neither is worth much.')
  await mustRun('npm', ['test'])
  // predist/postdist run tools/test-packaging.mjs fail-closed around this,
  // and dist itself re-asserts the host before electron-builder starts.
  await mustRun('npm', ['run', 'dist'])
}

// ── lane: win (magi-win, over ssh) ──────────────────────────────────────────

function winCmdScript(tag, version, names) {
  const dir = `${WIN_BUILD_ROOT}\\${remoteSlug(tag)}`
  // Every `npm` is `call npm`. cmd.exe TRANSFERS control to a batch file
  // rather than calling it, and npm on Windows is npm.cmd -- so a bare
  // `npm ci` here would end this script and every line below it would
  // silently never run, leaving a stale or absent release/ that looks like a
  // build failure with no error.
  return [
    '@echo off',
    'setlocal',
    `cd /d "${dir}" || exit /b 1`,
    'echo [release-all] extracting source',
    'tar -xf src.tar.gz || exit /b 1',
    'echo [release-all] npm ci',
    'call npm ci',
    'if errorlevel 1 exit /b 1',
    'echo [release-all] npm run dist:win',
    'call npm run dist:win',
    'if errorlevel 1 exit /b 1',
    `if not exist "${dir}\\release\\${names.win[0]}" exit /b 1`,
    `if not exist "${dir}\\release\\${names.win[2]}" exit /b 1`,
    'echo [release-all] done',
    'exit /b 0',
    '',
  ].join('\r\n')
}

async function legWin(tag, version, names, tmpDir) {
  header(`win lane -- ${WIN_HOST} (win32/x64), never cross-built`)
  const remoteDir = `${WIN_BUILD_ROOT}\\${remoteSlug(tag)}`
  const remoteDirScp = winScpPath(remoteDir)
  const tarball = path.join(tmpDir, 'src.tar.gz')
  const cmdFile = path.join(tmpDir, 'build.cmd')

  log('  source = `git archive` of HEAD. Not a clone: the box has no credentials for this repo,')
  log('  and an archive is exactly the tree, with no .git to drift from.')
  await mustRun('git', ['archive', '--format=tar.gz', '-o', tarball, 'HEAD'])
  if (!DRY) fs.writeFileSync(cmdFile, winCmdScript(tag, version, names))
  log(`  wrote ${shortPath(cmdFile)} (every npm invocation is \`call npm\`)`)

  // mkdir on cmd.exe creates intermediate directories. No pipes on the remote
  // side, ever -- a `| tail` here is interpreted by cmd.exe and swallows the
  // rest of the chain while still exiting 0.
  await mustRun('ssh', [...SSH_OPTS, WIN_HOST, `if not exist "${remoteDir}" mkdir "${remoteDir}"`])
  await mustRun('scp', [...SSH_OPTS, tarball, `${WIN_HOST}:${remoteDirScp}/src.tar.gz`])
  await mustRun('scp', [...SSH_OPTS, cmdFile, `${WIN_HOST}:${remoteDirScp}/build.cmd`])
  log('  the build runs in the FOREGROUND: anything backgrounded dies when this ssh session ends.')
  await mustRun('ssh', [...SSH_OPTS, WIN_HOST, `"${remoteDir}\\build.cmd"`])

  for (const n of names.win) {
    await mustRun('scp', [...SSH_OPTS, `${WIN_HOST}:${remoteDirScp}/release/${n}`, path.join(RELEASE_DIR, n)])
  }
}

// ── lane: linux (WSL2 on the same box) ──────────────────────────────────────

function wslShScript(tag, bundleName, names) {
  // exec </dev/null FIRST. Fed over stdin, git and npm consume the script
  // itself; even run by path, a child that reads stdin inherits the ssh
  // channel and hangs a build nobody is watching.
  return [
    '#!/bin/bash',
    'exec </dev/null',
    'set -euo pipefail',
    `TREE=${WSL_TREE}`,
    `BUNDLE=/mnt/c/Users/magi/${bundleName}`,
    'OUT=/mnt/c/Users/magi',
    'echo "[release-all] tree $TREE"',
    'cd "$TREE"',
    '# npm install leaves package-lock.json dirty here, and a dirty lockfile',
    '# blocks the checkout below with a message about local changes.',
    'git checkout -- package-lock.json 2>/dev/null || true',
    `git fetch --force "$BUNDLE" 'HEAD:refs/heads/${remoteSlug(tag)}'`,
    `git checkout --force ${remoteSlug(tag)}`,
    'git --no-pager log --oneline -1',
    'npm ci',
    'npm run dist:linux',
    `test -f "release/${names.linux[0]}"`,
    `test -f "release/${names.linux[1]}"`,
    '# scp cannot reach into the WSL filesystem; hand the artifacts to the',
    '# Windows side and let scp take them from there.',
    `cp "release/${names.linux[0]}" "$OUT/"`,
    `cp "release/${names.linux[1]}" "$OUT/"`,
    'echo "[release-all] done"',
    '',
  ].join('\n')
}

async function legLinux(tag, version, names, tmpDir) {
  header(`linux lane -- WSL2 ${WSL_DISTRO} on ${WIN_HOST} (linux/x64), ${WSL_TREE}`)
  const bundleName = `schz-${remoteSlug(tag)}.bundle`
  const shName = `schz-build-${remoteSlug(tag)}.sh`
  const bundle = path.join(tmpDir, bundleName)
  const sh = path.join(tmpDir, shName)

  log('  source = `git bundle` of HEAD. That tree has NO GitHub credentials, so the commit')
  log('  travels as one file rather than as a fetch the box cannot authenticate.')
  await mustRun('git', ['bundle', 'create', bundle, 'HEAD'])
  if (!DRY) fs.writeFileSync(sh, wslShScript(tag, bundleName, names))
  log(`  wrote ${shortPath(sh)} (first line: exec </dev/null)`)

  await mustRun('scp', [...SSH_OPTS, bundle, `${WIN_HOST}:${winScpPath(WIN_USER_DIR)}/${bundleName}`])
  await mustRun('scp', [...SSH_OPTS, sh, `${WIN_HOST}:${winScpPath(WIN_USER_DIR)}/${shName}`])
  log('  the script is run BY PATH, never piped into bash over stdin.')
  await mustRun('ssh', [...SSH_OPTS, WIN_HOST, `wsl -d ${WSL_DISTRO} -u root -- bash /mnt/c/Users/magi/${shName}`])

  for (const n of names.linux) {
    await mustRun('scp', [...SSH_OPTS, `${WIN_HOST}:${winScpPath(WIN_USER_DIR)}/${n}`, path.join(RELEASE_DIR, n)])
  }
}

// ── verification: open what came back and say what is inside ────────────────

function verifyYml(ymlName, version, artifactName) {
  const yml = path.join(RELEASE_DIR, ymlName)
  if (!ok(`${ymlName} exists`, fs.existsSync(yml),
    'without it every installed copy\'s update check errors silently')) return
  const parsed = parseLatestYml(fs.readFileSync(yml, 'utf8'))
  ok(`${ymlName} version is ${version}`, parsed.version === version, `it says ${parsed.version}`)
  const entry = parsed.files.find((f) => f.url === artifactName)
  if (!ok(`${ymlName} lists ${artifactName}`, !!entry, `it lists ${parsed.files.map((f) => f.url).join(', ') || '(nothing)'}`)) return
  const art = path.join(RELEASE_DIR, artifactName)
  if (!fs.existsSync(art)) return // the artifact row below already failed
  const size = fs.statSync(art).size
  ok(`${ymlName} size matches the artifact on disk (${size} B)`, entry.size === size, `yml says ${entry.size}`)
  // The updater refuses a download whose hash disagrees. A yml written for a
  // different build is therefore not a cosmetic mismatch -- it is an update
  // that can never complete, on every installed copy, silently.
  ok(`${ymlName} sha512 matches the artifact's bytes`, entry.sha512 === sha512b64(art),
    'electron-updater rejects the download; the update fails for every user with no visible cause')
}

function verifyMac(version, names) {
  const [dmg, blockmap, yml] = names.mac
  const p = path.join(RELEASE_DIR, dmg)
  if (ok(`${dmg} exists`, fs.existsSync(p))) {
    log(`        file: ${fileHeader(p)}`)
    log(`        size: ${fs.statSync(p).size} B`)
  }
  ok(`${blockmap} exists`, fs.existsSync(path.join(RELEASE_DIR, blockmap)),
    'without a blockmap the updater downloads the whole artifact instead of the delta')
  verifyYml(yml, version, dmg)
}

function verifyWin(version, names) {
  const [exe, blockmap, yml] = names.win
  const p = path.join(RELEASE_DIR, exe)
  if (ok(`${exe} exists`, fs.existsSync(p))) {
    const h = fileHeader(p) || ''
    log(`        file: ${h}`)
    log(`        size: ${fs.statSync(p).size} B`)
    // NOT an arch assertion, and the reason matters. Measured on the real
    // published v0.2.20 asset (a native Windows-box build):
    //
    //   PE32 executable (GUI) Intel 80386, for MS Windows,
    //   Nullsoft Installer self-extracting archive
    //
    // PE32 i386, not PE32+ x86-64 -- because the NSIS *stub* is a 32-bit
    // program by design on every NSIS installer ever built, whatever
    // architecture the payload inside it is. Asserting "PE32+ x86-64" here
    // would fail every correct artifact this project will ever produce, and a
    // gate that cries wolf on the good case gets waived on the bad one.
    //
    // So this row asks the two questions `file` can actually answer: is it a
    // Windows executable at all (a mac- or linux-built binary under an .exe
    // name fails here), and is it the NSIS installer we asked electron-builder
    // for. The x64-ness of the PAYLOAD is guaranteed one level in, by the pair
    // that runs inside the Windows build itself: tools/assert-platform.mjs
    // refuses the wrong host, and test-packaging's NATIVES gate opens the
    // staged bundle and names any foreign native in it.
    ok(`${exe} is a Windows PE NSIS installer`, /PE32/.test(h) && /Nullsoft/i.test(h),
      `file says ${JSON.stringify(h)} -- not a Windows installer at all`)
  }
  ok(`${blockmap} exists`, fs.existsSync(path.join(RELEASE_DIR, blockmap)),
    'Windows updater mode is auto; a missing blockmap turns every delta into a full download')
  verifyYml(yml, version, exe)
}

function verifyLinux(version, names) {
  const [appimage, yml] = names.linux
  const p = path.join(RELEASE_DIR, appimage)
  if (ok(`${appimage} exists`, fs.existsSync(p))) {
    const h = fileHeader(p) || ''
    log(`        file: ${h}`)
    log(`        size: ${fs.statSync(p).size} B`)
    // This exact row is the one that would have caught v0.2.20: its AppRun was
    // an aarch64 ELF inside a file named x86_64.
    ok(`${appimage} is an ELF x86-64 binary`, /ELF/.test(h) && /x86-64/.test(h),
      `file says ${JSON.stringify(h)} -- an "x86_64"-named artifact no x86_64 Linux can execute (the v0.2.20 defect)`)
  }
  verifyYml(yml, version, appimage)
}

// ── publish ─────────────────────────────────────────────────────────────────

function assetPaths(lanes, names) {
  const out = []
  for (const lane of lanes) for (const n of names[lane]) out.push(path.join('release', n))
  return out
}

async function publish(opts, tag, lanes, names) {
  header(`publish -- ${RELEASE_REPO}`)
  const assets = assetPaths(lanes, names)
  const exists = q('gh', ['release', 'view', tag, '-R', RELEASE_REPO, '--json', 'tagName']).code === 0

  const createArgs = ['release', 'create', tag, '-R', RELEASE_REPO, '--title', tag,
    ...(opts.notes ? ['--notes-file', opts.notes] : []), ...assets]
  const uploadArgs = ['release', 'upload', tag, '-R', RELEASE_REPO, ...assets, '--clobber']

  log(`  release ${tag} ${exists ? 'ALREADY EXISTS on the feed' : 'does not exist yet'}`)
  log(`  ${assets.length} asset(s):`)
  for (const a of assets) {
    const p = path.join(ROOT, a)
    log(`    ${fs.existsSync(p) ? String(fs.statSync(p).size).padStart(12) : '     MISSING'}  ${a}`)
  }
  log('')
  log(`  $ gh ${(exists ? uploadArgs : createArgs).map((x) => (/[\s"']/.test(x) ? JSON.stringify(x) : x)).join(' ')}`)

  if (!opts.publish) {
    log('\n  --publish was NOT passed: nothing was uploaded. Publishing is a human call.')
    return
  }
  if (exists && !opts.clobber) {
    failures++
    log(`\n  FAIL  ${tag} already exists on ${RELEASE_REPO} and --clobber was not passed.`)
    log('        Re-uploading over a published release replaces what installed copies are already polling.')
    return
  }
  if (failures > 0) {
    log(`\n  refusing to publish: ${failures} verification failure(s) above.`)
    return
  }
  await mustRun('gh', exists ? uploadArgs : createArgs)
  log(`\n  published. Verify: gh release view ${tag} -R ${RELEASE_REPO} --json assets`)
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) { usage(); return 0 }
  DRY = opts.dryRun
  REHEARSE = opts.rehearseRemote

  const tag = opts.tag || `v${pkg.version}`
  const lanes = opts.only.length ? [...new Set(opts.only)] : ['mac', 'win', 'linux']
  const version = tag.replace(/^v/, '')
  const names = artifactNames(version)

  fs.mkdirSync(RELEASE_DIR, { recursive: true })
  logStream = path.join(RELEASE_DIR, `release-all-${tag}.log`)
  try { fs.writeFileSync(logStream, '') } catch { logStream = null }

  log(`release-all ${tag} -- lanes: ${lanes.join(', ')}${DRY ? '  [DRY RUN: nothing is executed]' : ''}`)
  log(`node ${process.versions.node} on ${process.platform}/${process.arch}, ${new Date().toISOString()}`)
  if (logStream) log(`log: ${path.relative(ROOT, logStream)}`)

  // Explicit, and only ever alongside --allow-dirty. Letting a plain
  // --allow-dirty reach the shared box would make the safe-by-default flag
  // unsafe by default, which is the whole reason its guard exists.
  if (opts.rehearseRemote && !opts.allowDirty) {
    console.error('release-all: --rehearse-remote is only valid with --allow-dirty. It exists to rehearse the shared-box legs off an untagged tree; a real release run builds into the release locations and needs no rehearsal.')
    return 2
  }
  if (opts.rehearseRemote) {
    log(`  ** REHEARSAL: win/linux run FOR REAL on ${WIN_HOST}, into ${WIN_BUILD_ROOT}\\${remoteSlug(tag)} and WSL branch ${remoteSlug(tag)} -- not the release locations; artifacts are NOT releasable. **`)
  }
  if (opts.publish && opts.allowDirty) {
    console.error('release-all: --publish and --allow-dirty are mutually exclusive. A rehearsal build is not releasable.')
    return 2
  }
  if (opts.publish && !opts.notes) {
    console.error('release-all: --publish needs --notes <file>. A release with no notes is not a release anyone can read.')
    return 2
  }
  if (opts.notes && !fs.existsSync(path.resolve(ROOT, opts.notes))) {
    console.error(`release-all: --notes file not found: ${opts.notes}`)
    return 2
  }

  preflight(opts, tag)
  if (failures > 0) { log(`\nrelease-all: ${failures} preflight failure(s) -- nothing was built.`); return 1 }

  // The remote legs refuse to run on a host that is not this Mac's own; they
  // reach a SHARED box, so a rehearsal must never touch it.
  if (opts.allowDirty && !opts.rehearseRemote && (lanes.includes('win') || lanes.includes('linux')) && !DRY && !opts.verifyOnly) {
    log('\nrelease-all: --allow-dirty is a local rehearsal. The win/linux legs touch a shared box,')
    log('             so they are skipped unless you pass --dry-run to see their commands, or')
    log('             --rehearse-remote to run them for real into rehearsal locations.')
    lanes.splice(0, lanes.length, ...lanes.filter((l) => l === 'mac'))
    if (!lanes.length) { log('             nothing left to do.'); return 0 }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `schz-release-${tag}-`))
  try {
    if (opts.verifyOnly) log('\n--verify-only: building nothing; opening what release/ already holds.')
    else if (lanes.includes('mac')) await legMac()
    if (!opts.verifyOnly && lanes.includes('win')) await legWin(tag, version, names, tmpDir)
    if (!opts.verifyOnly && lanes.includes('linux')) await legLinux(tag, version, names, tmpDir)
  } catch (e) {
    failures++
    log(`\n  FAIL  ${e && e.message ? e.message : e}`)
  }

  header('verify -- every artifact opened, not assumed')
  if (DRY) {
    log('  (dry run: nothing was built, so there is nothing to open. The rows that would run:)')
    for (const lane of lanes) log(`    ${lane}: ${names[lane].join(', ')}`)
  } else {
    if (lanes.includes('mac')) verifyMac(version, names)
    if (lanes.includes('win')) verifyWin(version, names)
    if (lanes.includes('linux')) verifyLinux(version, names)
  }

  await publish(opts, tag, lanes, names)

  if (!opts.keepRemote && !DRY && !opts.verifyOnly && (lanes.includes('win') || lanes.includes('linux'))) {
    header('cleanup -- remote build directory')
    await run('ssh', [...SSH_OPTS, WIN_HOST, `if exist "${WIN_BUILD_ROOT}\\${remoteSlug(tag)}" rmdir /s /q "${WIN_BUILD_ROOT}\\${remoteSlug(tag)}"`])
  }

  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* tmp */ }

  header('summary')
  log(`  ${checks - failures} ok, ${failures} failed`)
  if (logStream) log(`  log: ${path.relative(ROOT, logStream)}`)
  return failures ? 1 : 0
}

main().then(
  (code) => { process.exitCode = code },
  (e) => { console.error('release-all: crashed:', e && e.stack ? e.stack : e); process.exitCode = 1 },
)
