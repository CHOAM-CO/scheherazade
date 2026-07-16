// test-packaging.mjs -- does the thing we built actually ship?
// Run: node scripts/test-packaging.mjs
//
// Tonight I built autonomy/ and calendar/, wrote 143 assertions across them,
// ran them all green, and pushed. Neither directory was in package.json's
// build.files. The DMG would not have contained a single line of it. The
// watcher would have died on require(), the calendar MCP server would have had
// no file to spawn, and every test would still have been green, because tests
// run from the repo and the repo has the files.
//
// So the manifest does not get to depend on my memory. This scans the code for
// directories it loads at RUNTIME and checks them against the build config.
//
// Two different questions, and both have to be yes:
//   build.files      -- is it in the app at all?
//   build.asarUnpack -- is it a REAL FILE on disk?
// The second is not a nicety. channel.mjs and the MCP servers are spawned as
// plain `node` child processes by the claude CLI, and plain node cannot read
// inside app.asar. That is why hooks/ and scripts/ were already unpacked. A file
// that ships only inside the archive is a file that exists and cannot be opened.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const covers = (patterns, dir) =>
  patterns.some((p) => p === dir || p.startsWith(`${dir}/`) || p.startsWith(`${dir}/**`))

// ── what the code actually loads at runtime ─────────────────────────────────
// Scanned, not listed. A directory added next month is caught without anyone
// remembering this file exists.
function dirsReferencedBy(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const found = new Set()
  // The root identifier is spelled differently in every file (MODULE_DIR, HERE,
  // REPO_ROOT, __dirname), so match the SHAPE rather than the names I happen to
  // remember -- the first version of this hardcoded the names and silently
  // missed calendar/, which is the exact bug it was written to catch.
  for (const m of src.matchAll(/path\.join\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*'([^']+)'\s*,/g)) {
    found.add(m[1])
  }
  // '<dir>/<file>.mjs' written as one literal
  for (const m of src.matchAll(/'([a-z][a-z0-9_-]*)\/[a-z0-9_.-]+\.(?:mjs|cjs|js)'/gi)) {
    found.add(m[1])
  }
  return [...found].filter((d) => {
    if (d.startsWith('.')) return false // '..' is not a directory we ship
    try { return fs.statSync(path.join(ROOT, d)).isDirectory() } catch { return false }
  })
}

const CHANNEL_SCRIPTS = ['channel.mjs', 'channel-slack.mjs', 'channel-telegram.mjs']
const RUNTIME_ENTRYPOINTS = [...CHANNEL_SCRIPTS, 'onboarding/http-server.cjs', 'main.cjs']
const referenced = new Set()
for (const f of RUNTIME_ENTRYPOINTS) {
  if (!fs.existsSync(path.join(ROOT, f))) continue
  for (const d of dirsReferencedBy(f)) referenced.add(d)
}

console.log(`\n-- directories loaded at runtime: ${[...referenced].sort().join(', ') || '(none found -- the scanner is broken)'}`)
ok('the scanner found something (a scanner that finds nothing always passes)', referenced.size > 0)

// The two I built tonight, named explicitly. If the scanner regexes rot, these
// still hold the line -- a guard whose only witness is another guard is not one.
for (const d of ['autonomy', 'calendar']) {
  ok(`${d}/ is referenced by the runtime code (scan found it)`, referenced.has(d))
}

console.log('\n-- is it in the app at all? (build.files)')
for (const d of [...referenced].sort()) {
  ok(`${d}/ ships`, covers(pkg.build.files, d), `add "${d}/**/*" to build.files -- the DMG has no ${d}/`)
}
// The channel backends, named explicitly (multichannel v0.0.18): build.files
// lists channel scripts as SINGLE FILES, so the directory scan above never
// covers them -- a new backend that isn't named here ships as a switch
// option whose script does not exist in the DMG. That failure is silent
// until the user actually switches, which is the worst possible moment.
for (const f of CHANNEL_SCRIPTS) {
  ok(`${f} ships (named in build.files)`, pkg.build.files.includes(f), `add "${f}" to build.files -- switching to this backend in the packaged app spawns a script that is not there`)
}

console.log('\n-- is it a real file on disk? (build.asarUnpack)')
// NOT every runtime directory needs unpacking, and the first version of this
// demanded it for all of them -- which flagged onboarding/ as broken when it is
// fine. Electron's own fs reads inside app.asar; only processes OUTSIDE Electron
// cannot. So the rule is about WHO OPENS IT:
//
//   channel.mjs        -- spawned by the claude CLI as a plain node child. Every
//                         directory it requires must be a real file on disk.
//   toUnpackedPath(..) -- the code's own declaration that this path is about to
//                         be handed to something outside Electron (the CLI spawns
//                         calendar/server.mjs from it, via .mcp.json).
//   onboarding/        -- required by main.cjs, the Electron main process. Fine
//                         inside the archive.
const mustBeReal = new Set(CHANNEL_SCRIPTS.flatMap((f) => dirsReferencedBy(f)))
// Every channel script is itself spawned by the claude CLI as a plain node
// child (via .mcp.json) -- each must be a real file, not an asar member.
for (const f of CHANNEL_SCRIPTS) mustBeReal.add(f)
for (const f of RUNTIME_ENTRYPOINTS) {
  if (!fs.existsSync(path.join(ROOT, f))) continue
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
  for (const m of src.matchAll(/toUnpackedPath\(\s*path\.join\(\s*[A-Za-z_$][A-Za-z0-9_$]*\s*,\s*'([^']+)'/g)) {
    mustBeReal.add(m[1])
  }
}
console.log(`   (outside Electron: ${[...mustBeReal].sort().join(', ')})`)
ok('the calendar server is known to run outside Electron', mustBeReal.has('calendar'),
  'the CLI spawns it as a plain node process; if the scan lost that, the unpack check below is empty and always passes')
// Some of these are single files (channel.mjs, run.sh), not directories. Print
// them as what they are: a check that misnames what it looked at is one you
// cannot read the output of.
for (const d of [...mustBeReal].sort()) {
  const isDir = fs.existsSync(path.join(ROOT, d)) && fs.statSync(path.join(ROOT, d)).isDirectory()
  ok(`${isDir ? `${d}/` : d} is readable by a non-electron process`, covers(pkg.build.asarUnpack, d),
    `add "${d}${isDir ? '/**' : ''}" to build.asarUnpack -- plain node cannot read inside app.asar`)
}

console.log('\n-- node-pty: the one native module (supervisor lane)')
// node-pty 1.1.0's published tarball ships spawn-helper WITHOUT the exec bit
// (verified against the registry tarball, 2026-07-14) -- every pty.spawn on
// macOS dies with "posix_spawnp failed". Our postinstall
// (scripts/fix-pty-helper.mjs) repairs the repo copy; THIS check is the hard
// gate on what actually ships. Artifact checks skip LOUDLY when no build
// output exists (fresh clone) -- a skip that looks like a pass would defeat
// the point of this file.
ok('postinstall wires the spawn-helper exec-bit repair', (pkg.scripts.postinstall || '').includes('fix-pty-helper'),
  'npm-installed node-pty arrives broken on macOS without it')
// node-pty is N-API: the npm prebuilt binding passed the pty probe under BOTH
// runtimes (node abi 137, electron abi 148 -- receipts in
// docs/supervisor-design.md), so electron-builder's rebuild buys nothing and
// adds a second binary lineage (build/Release shadows prebuilds in node-pty's
// loader order). Honest history: the artifact probe failure was FIRST blamed
// on the rebuilt binding -- wrong. The real cause was node-pty's helperPath
// double-replace (see fix-pty-helper.mjs defect 2), which breaks ANY binding
// loaded from an app.asar.unpacked path. npmRebuild stays false for the
// determinism reason, not the debunked one.
ok('electron-builder native rebuild is OFF (npmRebuild:false)', pkg.build.npmRebuild === false,
  'the N-API prebuild already works under both runtimes; a rebuild only adds a shadowing second lineage')
const PATCHED_LINE = "if (!helperPath.includes('app.asar.unpacked')) helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');"
ok('postinstall carries the helperPath double-replace patch', fs.readFileSync(path.join(ROOT, 'scripts', 'fix-pty-helper.mjs'), 'utf8').includes(PATCHED_LINE),
  'without it, pty.spawn from the unpacked tree resolves spawn-helper to app.asar.unpacked.unpacked -> ENOENT')
ok('repo node_modules unixTerminal.js is patched (postinstall ran)', fs.readFileSync(path.join(ROOT, 'node_modules', 'node-pty', 'lib', 'unixTerminal.js'), 'utf8').includes(PATCHED_LINE),
  'run node scripts/fix-pty-helper.mjs (or npm install) -- the unpatched line corrupts helperPath in the packed app')
{
  const unpackedPty = path.join(ROOT, 'release', 'mac-arm64', 'Scheherazade.app', 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty')
  if (!fs.existsSync(unpackedPty)) {
    console.log('  SKIP  built-artifact node-pty checks -- no release/mac-arm64 build output present (run npm run dist first); NOT a pass')
  } else {
    const helper = path.join(unpackedPty, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    const binding = path.join(unpackedPty, 'prebuilds', 'darwin-arm64', 'pty.node')
    ok('artifact carries the darwin-arm64 pty.node prebuild as a real file', fs.existsSync(binding))
    ok('artifact spawn-helper exists as a real file', fs.existsSync(helper))
    ok('artifact spawn-helper is EXECUTABLE (the upstream tarball defect, caught at ship time)',
      fs.existsSync(helper) && Boolean(fs.statSync(helper).mode & 0o111),
      'a stripped exec bit means pty.spawn posix_spawnp-fails in the shipped app')
    ok('artifact has NO build/Release shadowing the prebuild', !fs.existsSync(path.join(unpackedPty, 'build', 'Release')),
      'node-pty loads build/Release FIRST; a second lineage there silently wins over the tested prebuild (rm -rf node_modules/node-pty/build before dist)')
    ok('artifact unixTerminal.js carries the helperPath patch', fs.readFileSync(path.join(unpackedPty, 'lib', 'unixTerminal.js'), 'utf8').includes(PATCHED_LINE),
      'the shipped app would corrupt helperPath to app.asar.unpacked.unpacked at first pty.spawn')
  }
}

console.log('\n-- bundled claude CLI: per-platform extraResources (win-port Phase 2)')
{
  // The old GLOBAL extraResources entry mapped bin/claude.exe -> claude-cli/
  // claude for every platform. That extension strip is deliberate on mac
  // (the claude-code postinstall hardlinks a Mach-O over the .exe
  // placeholder) and FATAL on Windows (an extensionless PE is not
  // executable). The mapping is now per-platform and resolveClaudeBin()
  // picks the matching name -- these three checks keep that trio welded.
  ok('no GLOBAL extraResources entry (the extension-strip-everywhere shape)', !pkg.build.extraResources,
    'a global entry silently re-breaks the win artifact; keep the mapping under build.mac / build.win')
  const macER = (pkg.build.mac && pkg.build.mac.extraResources) || []
  ok('mac lane bundles the CLI as claude-cli/claude (extensionless Mach-O)',
    macER.some((e) => e.from === 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' && e.to === 'claude-cli/claude'))
  const winER = (pkg.build.win && pkg.build.win.extraResources) || []
  ok('win lane bundles the CLI as claude-cli/claude.exe (extension preserved)',
    winER.some((e) => e.from === 'node_modules/@anthropic-ai/claude-code/bin/claude.exe' && e.to === 'claude-cli/claude.exe'))
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  ok("resolveClaudeBin picks the platform-matching bundled name", mainSrc.includes("isWin ? 'claude.exe' : 'claude'"))
}

console.log('\n-- the permission strings the OS shows the user')
const info = (pkg.build.mac && pkg.build.mac.extendInfo) || {}
ok('calendar full-access usage string is declared', typeof info.NSCalendarsFullAccessUsageDescription === 'string' && info.NSCalendarsFullAccessUsageDescription.length > 10,
  'without it macOS kills the process instead of prompting')
ok('...and it says we only READ', /읽/.test(info.NSCalendarsFullAccessUsageDescription || ''))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
