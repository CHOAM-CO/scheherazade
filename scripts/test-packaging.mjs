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
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
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

// DERIVED, not listed. This was a hardcoded array of three until 2026-07-30,
// which meant adding a fourth backend (channel-local.mjs) produced a script
// that shipped unchecked: not verified for dmg membership, not verified as
// unpacked, not dependency-closed -- by the very test whose reason for
// existing is that a channel script which is missing or asar-trapped dies at
// spawn. The list now comes from the same object the runtime picks a backend
// out of, so the next backend is covered by adding it there and nowhere else.
const CHANNEL_SCRIPTS = Object.values(
  require('../onboarding/http-server.cjs').CHANNEL_SCRIPT_PATHS,
).map((p) => path.basename(p))
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

// ── root-local single-file modules ──────────────────────────────────────────
// v0.0.23 shipped a dmg that died at open: main.cjs required ./attach-topology.cjs,
// a NEW root-level file, and build.files is an allowlist that nobody extended.
// The directory scanner above never saw it -- its regexes match 'dir/file' shapes
// and its filter drops anything starting with '.', which is exactly what
// require('./x.cjs') looks like. Same bug class, one level shallower. Scan it.
// Is a ROOT-relative file path shipped by build.files? build.files lists exact
// names AND directory globs ('onboarding/**/*'), so an exact .includes() check
// (the old code) only ever worked for root-level files -- it would miss every
// onboarding/-relative require the resolver below now correctly surfaces.
function shipsUnderBuildFiles(relPath, patterns) {
  for (const p of patterns) {
    if (p.startsWith('!')) continue // negation entries never ADD coverage
    if (p === relPath) return true
    const dir = p.replace(/\/\*\*\/\*$|\/\*\*$|\/\*$/, '') // strip a trailing glob
    if (dir !== p && (relPath === dir || relPath.startsWith(dir + '/'))) return true
  }
  return false
}

function rootModulesReferencedBy(file) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  const fileDir = path.dirname(file) // ROOT-relative dir of the REQUIRING file
  const found = new Set()
  // Both quote styles: the single-quote-only regex silently missed
  // require("./x") (blocker-1, Skia red-team 2026-07-23). Relative specs only
  // (./ or ../) -- bare-package requires resolve to node_modules, not our ship.
  for (const m of src.matchAll(/require\(\s*['"](\.\.?\/[A-Za-z0-9_./-]+\.(?:cjs|mjs|js))['"]\s*\)/g)) found.add(m[1])
  for (const m of src.matchAll(/from\s+['"](\.\.?\/[A-Za-z0-9_./-]+\.(?:cjs|mjs|js))['"]/g)) found.add(m[1])
  // Resolve each spec RELATIVE TO THE REQUIRING FILE, not ROOT. The old code
  // joined against ROOT, so onboarding/http-server.cjs's require('./login-
  // status.cjs') resolved to ROOT/login-status.cjs, missed on statSync, and
  // got dropped by a silent catch -- hiding whether it actually ships. That
  // exact blind spot is blocker-1.
  // POSIX separators, always. These are LOGICAL repo-relative ids that get
  // compared against build.files globs, and electron-builder globs are '/'
  // on every platform. path.join/normalize hand back 'onboarding\routes\
  // chat.cjs' on Windows, which matches no pattern -- so on the win box every
  // nested require reported "does not ship" and predist:win failed 21 rows,
  // making `npm run dist:win` unbuildable (found 2026-08-03, first real run
  // on magi-win). fs.existsSync takes forward slashes on Windows fine.
  return [...found].map((spec) => path.posix.normalize(path.posix.join(fileDir.split(path.sep).join('/'), spec)))
}

// blocker-1 (Skia red-team 2026-07-23): the old scan walked ONE hop from the
// fixed entrypoint list. A file an entrypoint requires that ITSELF requires a
// missing module shipped 59-passed -- login-status.cjs -> nested-missing.cjs was
// invisible to a 1-hop scan. Walk the WHOLE require graph; a visited-set
// terminates cycles (A->B->A resolves instead of looping forever).
function requireClosure(entrypoints) {
  const visited = new Set()
  const modules = new Set()
  const queue = [...entrypoints]
  while (queue.length) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    // A dead require is caught by the existence check below; here we simply
    // cannot recurse into a file that is not on disk.
    if (!fs.existsSync(path.join(ROOT, file))) continue
    for (const m of rootModulesReferencedBy(file)) {
      modules.add(m)
      if (!visited.has(m)) queue.push(m)
    }
  }
  return modules
}

// Dynamic-import / spawn targets the literal-require scanner CANNOT see
// (issue #9 PR-1 red-team catch): onboarding/http-server.cjs reaches
// memory/service.mjs via a computed pathToFileURL() import, and
// memory/server.mjs is spawned by the claude CLI per .mcp.json -- neither
// ever appears as a literal relative require/from specifier, so without
// this seed list the memory system's two essential files ride on nothing
// but the coarse memory/** glob (which proves SOMETHING under memory/
// ships, not that THESE files do). Seeding them here runs the same
// per-file checks the require graph gets: exists in tree, ships via
// build.files, and is a real member of the shipped asar.
// EXPECTED RED until the first build after the #9 split, as a CLASS: any
// file born after the currently-mounted DMG was built fails its
// mounted-DMG membership row here (channel-runtime.mjs after #8;
// memory/service.mjs after #9 PR-1; the nine onboarding/routes/*.cjs
// files after #9 PR-2 -- 11 rows total against the v0.0.28 DMG). All go
// green at the next release build. Each failure line names its file
// explicitly; before diagnosing one as a real dead require, check whether
// the file simply postdates the mounted DMG (git log --follow <file> vs
// the DMG's version).
const DYNAMIC_TARGETS = ['memory/server.mjs', 'memory/service.mjs']
const rootModules = requireClosure([...RUNTIME_ENTRYPOINTS, ...DYNAMIC_TARGETS])
// requireClosure records only REFERENCED modules, never its seeds -- add the
// seeds explicitly so they get the per-file checks themselves.
for (const t of DYNAMIC_TARGETS) rootModules.add(t)

console.log(`\n-- relative modules required by entrypoints: ${[...rootModules].sort().join(', ') || '(none)'}`)
for (const m of [...rootModules].sort()) {
  // Two open-time-fatal failure modes, neither caught before (blocker-1):
  // (1) the required file is missing from the tree = a dead require;
  // (2) it exists but build.files doesn't ship it = dropped from asar (v0.0.23).
  ok(`${m} exists in the source tree (a require of a missing file kills the app at open)`,
    fs.existsSync(path.join(ROOT, m)))
  ok(`${m} ships via build.files (a required file that does not ship kills the app at open)`,
    shipsUnderBuildFiles(m, pkg.build.files))
}
// The one that already burned us, named explicitly -- if the require regexes rot,
// this line still holds (same principle as the autonomy/calendar anchors above).
ok('attach-topology.cjs is caught by the root-module scan', rootModules.has('attach-topology.cjs'))

// ── lane dispatch: mac / win / linux ────────────────────────────────────────
// The build runs ON its target platform -- every dist* lane is hard-gated by
// scripts/assert-platform.mjs -- so process.platform picks the lane. Linux was
// the missing third until 0.3 P2: a run on Linux took the MAC branch, looked
// for a dmg that cannot exist there, and failed for a reason that says nothing
// about the AppImage it was supposed to verify. That silence is half of how a
// mac-built, aarch64, darwin-natives "x86_64" AppImage shipped as v0.2.20.
const LANE = process.platform === 'win32' ? 'win' : process.platform === 'linux' ? 'linux' : 'mac'
const WIN_LANE = LANE === 'win'
const PRODUCT = (pkg.build && pkg.build.productName) || 'Scheherazade'

// Artifact names, arches and staging directories are DERIVED from the same
// build config electron-builder reads. build.linux.artifactName hardcodes
// `x86_64` on purpose (assert-platform.mjs is what makes that literal honest,
// and published asset names stay stable across 0.2.19/0.2.20/0.3.0) -- a
// second hand-typed copy of that string in this file is a second thing that
// can drift from what actually gets built.
function configuredArch(lane) {
  for (const t of ((pkg.build[lane] || {}).target) || []) {
    const arches = (t && t.arch) || []
    if (arches.length) return arches[0]
  }
  return process.arch
}
function renderArtifactName(tmpl, arch) {
  const rendered = String(tmpl)
    .replace(/\$\{version\}/g, pkg.version)
    .replace(/\$\{productName\}/g, PRODUCT)
    .replace(/\$\{name\}/g, pkg.name)
    .replace(/\$\{arch\}/g, arch)
  // An unresolved token silently produces a filename nothing matches, and
  // "the artifact does not exist" is the one failure this file must never
  // report for the wrong reason.
  if (/\$\{/.test(rendered)) throw new Error(`unresolved token in ${LANE}.artifactName ${JSON.stringify(tmpl)} -> ${rendered}`)
  return rendered
}

const LANE_ARCH = configuredArch(LANE)
// electron-builder's staging-directory convention: x64 is the unsuffixed
// default, every other arch is suffixed.
const STAGE_DIR = {
  mac: LANE_ARCH === 'x64' ? 'mac' : `mac-${LANE_ARCH}`,
  win: LANE_ARCH === 'x64' ? 'win-unpacked' : `win-${LANE_ARCH}-unpacked`,
  linux: LANE_ARCH === 'x64' ? 'linux-unpacked' : `linux-${LANE_ARCH}-unpacked`,
}[LANE]
// Where app.asar, app.asar.unpacked and the extraResources sit inside it.
const STAGED_RESOURCES = LANE === 'mac'
  ? path.join(ROOT, 'release', STAGE_DIR, `${PRODUCT}.app`, 'Contents', 'Resources')
  : path.join(ROOT, 'release', STAGE_DIR, 'resources')
const ARTIFACT_NAME = LANE === 'mac'
  // mac declares no artifactName; electron-builder's dmg default carries the
  // arch for anything but x64, which is what release/ actually holds.
  ? `${PRODUCT}-${pkg.version}-${LANE_ARCH}.dmg`
  : renderArtifactName((pkg.build[LANE] || {}).artifactName, LANE_ARCH)
const ARTIFACT_PATH = path.join(ROOT, 'release', ARTIFACT_NAME)
const ARTIFACT_NOUN = { mac: 'dmg', win: 'installer', linux: 'AppImage' }[LANE]
const DIST_SCRIPT = { mac: 'npm run dist', win: 'npm run dist:win', linux: 'npm run dist:linux' }[LANE]

// ── the required graph vs the ACTUAL shipped asar ───────────────────────────
// Skia's sharpening (2026-07-23): re-checking source existence + build.files
// coverage reproduces the staging illusion -- v0.0.23 was test-green yet its
// app.asar was missing attach-topology.cjs. Existence-in-tree and pattern-
// coverage are what the app WILL ship in theory; they are not what the artifact
// DID ship. So open the real thing, list its app.asar, and prove every graph
// node is a real member. Runs in postdist (the artifact exists); predist skips
// LOUDLY.
//
// mac opens the DMG itself (hdiutil), because it can. win and linux read the
// staging tree electron-builder wrote in the SAME run that packed the
// installer/AppImage -- same bytes, one hop before compression -- because
// neither an NSIS installer nor an AppImage can be opened without a tool
// nobody installs (7z / a loop mount). The mac exact-filename trick does not
// defend that path, so the version illusion is killed harder there: read
// package.json OUT OF the staged asar and demand an exact match, so a stale
// win-unpacked/linux-unpacked from last week fails loudly instead of
// verifying green.
function mountedAsarEntries() {
  // EXACT version only. A different-version dmg (e.g. an old 0.0.24 left in
  // release/) is NOT proof of THIS build's asar; verifying it would be a version
  // illusion (Skia catch). Absent the exact dmg -> no-artifact -> postdist FAILs.
  if (!fs.existsSync(ARTIFACT_PATH)) return { status: 'no-artifact' }
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-dmg-closure-'))
  let attached = false
  try {
    execFileSync('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mnt, ARTIFACT_PATH], { stdio: 'pipe' })
    attached = true
    const resources = path.join(mnt, `${PRODUCT}.app`, 'Contents', 'Resources')
    const asarPath = path.join(resources, 'app.asar')
    if (!fs.existsSync(asarPath)) return { status: 'error', reason: 'app.asar absent inside the mounted dmg' }
    // listPackage yields '/onboarding/login-status.cjs' (leading slash, dirs
    // included); normalize to the ROOT-relative shape the closure produces.
    const entries = require('@electron/asar').listPackage(asarPath)
    // extraResources ride NEXT TO app.asar, so asar listing never sees them --
    // check the vendored chromux (v0.1.10 web-search path) directly.
    const chromuxShipped = fs.existsSync(path.join(resources, 'chromux', 'chromux.mjs'))
    const agentToolsShipped = fs.existsSync(path.join(resources, 'agent-tools', 'windowshot.cjs'))
    // The natives live OUTSIDE the asar, in app.asar.unpacked. The DMG's copy
    // is what a user actually gets, so that is the tree the natives gate
    // reads -- but it disappears with the unmount, so hand back the answer
    // rather than the path.
    const nativesDir = path.join(resources, 'app.asar.unpacked', 'node_modules')
    const natives = fs.existsSync(nativesDir) ? installedPackageNames(nativesDir) : null
    return { status: 'ok', entries: new Set(entries.map((e) => e.replace(/^\/+/, ''))), chromuxShipped, agentToolsShipped, natives }
  } catch (e) {
    // A DMG that EXISTS but will not mount / list is fail-CLOSED, never a skip.
    // (Skia fail-open catch: the old null-collapse let an hdiutil failure pass
    // as SKIP + exit 0 -- an unverified artifact shipping green, the v0.0.23 class.)
    return { status: 'error', reason: (e && e.message) || 'hdiutil/listPackage failed' }
  } finally {
    if (attached) { try { execFileSync('hdiutil', ['detach', mnt], { stdio: 'pipe' }) } catch {} }
    try { fs.rmSync(mnt, { recursive: true, force: true }) } catch {}
  }
}

function stagedAsarEntries() {
  // EXACT version only, same rule as the dmg: an old installer/AppImage left
  // in release/ is not proof of THIS build.
  if (!fs.existsSync(ARTIFACT_PATH)) return { status: 'no-artifact' }
  const asarPath = path.join(STAGED_RESOURCES, 'app.asar')
  if (!fs.existsSync(asarPath)) {
    return { status: 'error', reason: `the ${ARTIFACT_NOUN} exists but ${path.relative(ROOT, asarPath)} is absent -- cannot verify what it packed` }
  }
  try {
    const asar = require('@electron/asar')
    const staged = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
    if (staged.version !== pkg.version) {
      return { status: 'error', reason: `staged asar is version ${staged.version}, not ${pkg.version} -- stale ${STAGE_DIR}, verifying it would be the version illusion (Skia catch)` }
    }
    // Normalize to POSIX ids. listPackage hands back native separators, so on
    // Windows every entry read '\onboarding\routes\chat.cjs' while the require
    // graph produces 'onboarding/routes/chat.cjs' -- 29 shipped files reported
    // as dead requires against an asar that in fact contained all of them
    // (2026-08-03, first real dist:win). Strip the leading separator in either
    // form, then fold the rest.
    const entries = asar.listPackage(asarPath)
    // extraResources ride NEXT TO app.asar, invisible to the asar listing --
    // check the vendored chromux and agent-tools directly.
    const chromuxShipped = fs.existsSync(path.join(STAGED_RESOURCES, 'chromux', 'chromux.mjs'))
    const agentToolsShipped = fs.existsSync(path.join(STAGED_RESOURCES, 'agent-tools', 'windowshot.cjs'))
    const nativesDir = path.join(STAGED_RESOURCES, 'app.asar.unpacked', 'node_modules')
    const natives = fs.existsSync(nativesDir) ? installedPackageNames(nativesDir) : null
    return { status: 'ok', entries: new Set(entries.map((e) => e.replace(/^[/\\]+/, '').split('\\').join('/'))), chromuxShipped, agentToolsShipped, natives }
  } catch (e) {
    // fail-CLOSED, same as the dmg lane: an artifact that exists but cannot be
    // listed is an UNVERIFIED artifact, never a skip.
    return { status: 'error', reason: (e && e.message) || 'asar extract/list failed' }
  }
}

console.log(`\n-- the required graph vs the shipped asar (${LANE} lane: ${LANE === 'mac' ? 'mounted DMG' : `staged ${STAGE_DIR}`}; blocker-1 closure gate)`)
// predist runs BEFORE the build -- there is no fresh artifact to verify yet, so
// it legitimately skips. Every OTHER invocation (postdist, manual, CI) must find
// the exact-version artifact; a missing one is fail-closed, not a skip. (Skia
// catch: no-dmg postdist skipped green, and a version-fallback verified the
// wrong dmg.) startsWith: the lanes fire as predist:win / postdist:linux / ...
const lifecycle = process.env.npm_lifecycle_event || ''
// P1 (design-0023): this file is BOTH the predist/postdist ship gate and a
// member of the `npm test` suite. Those two callers want opposite things from a
// missing artifact. The ship gate must fail hard -- it is the only closure gate
// this project has on what actually ships. The suite runs on a working tree
// where nobody has built anything, and a permanently-red file in the default
// gate teaches everyone to ignore the gate.
//
// The runner (scripts/run-tests.mjs) sets RUN_TESTS=1 and, with --live,
// RUN_TESTS_LIVE=1. npm's predist/postdist hooks set NEITHER. So: under the
// runner without --live the artifact lane skips with the marker; from the dist
// lifecycle, from `npm test -- --live`, or from a bare manual run it is
// fail-closed exactly as before.
const RUNNER_WITHOUT_LIVE = process.env.RUN_TESTS === '1' && process.env.RUN_TESTS_LIVE !== '1'
const IS_PREDIST = lifecycle.startsWith('predist')
// The natives gate below needs the same artifact this section opened, and
// mounting the dmg twice would be both slow and a second chance to leave a
// volume attached. Whatever the lane learned about app.asar.unpacked/node_modules
// is stashed here for it.
let bundleNatives = null
if (IS_PREDIST) {
  console.log(`  SKIP  artifact asar closure -- predist (pre-build); postdist verifies the freshly built ${pkg.version} ${ARTIFACT_NOUN}; NOT a pass`)
} else if (RUNNER_WITHOUT_LIVE) {
  console.log(`SKIP: artifact asar closure -- needs a freshly built ${pkg.version} ${ARTIFACT_NOUN}; run \`npm test -- --live\` after a build, or \`${DIST_SCRIPT}\` (predist/postdist run this file fail-closed); NOT a pass`)
} else {
  const isPost = lifecycle.startsWith('postdist')
  const asarResult = LANE === 'mac' ? mountedAsarEntries() : stagedAsarEntries()
  if (asarResult.status === 'no-artifact') {
    // NOT predist: a missing exact-version artifact cannot be verified. In
    // postdist it means the build never produced it (or built a different version).
    ok(`the ${pkg.version} ${ARTIFACT_NOUN} exists to verify (${lifecycle || 'manual run'})`, false,
      `no release/${ARTIFACT_NAME} -- ${isPost ? 'the build did not produce it (or built a different version)' : `run ${DIST_SCRIPT} first`}`)
  } else if (asarResult.status === 'error') {
    // fail-CLOSED: the artifact EXISTS but would not mount / list. A green skip
    // here ships an UNVERIFIED artifact -- the v0.0.23 class, and exactly the
    // fail-open Skia's fake-hdiutil vector exposed (hdiutil exit1 -> SKIP ->
    // process exit 0).
    ok(LANE === 'mac' ? 'the built DMG mounts and its app.asar is listable'
                      : `the staged ${STAGE_DIR} asar matches this build and is listable`, false,
      `${LANE === 'mac' ? 'hdiutil/listPackage' : 'asar extract/list'} failed on an existing artifact: ${asarResult.reason}`)
  } else {
    bundleNatives = asarResult.natives
    const asarEntries = asarResult.entries
    ok(`the ${LANE === 'mac' ? 'mounted' : 'staged'} asar listed something (an empty listing always passes)`, asarEntries.size > 0)
    ok('vendored chromux ships as an extraResource next to app.asar (web-search path for non-Anthropic backends)',
      asarResult.chromuxShipped === true,
      'build.extraResources should carry vendor/chromux -> chromux; without it syncChromuxPortable() no-ops and the websearch skill points at nothing')
    ok('agent-tools ship as an extraResource next to app.asar (같이보기 windowshot helper)',
      asarResult.agentToolsShipped === true,
      'build.extraResources should carry onboarding/agent-tools -> agent-tools; without it syncAgentTools() no-ops on packaged installs (dev lane still finds the repo copy, so only packaged apps break) and the windowshot skill points at nothing')
    for (const m of [...rootModules].sort()) {
      ok(`${m} is a real member of the shipped app.asar (${LANE === 'mac' ? 'mounted DMG, not staging' : `staged ${STAGE_DIR}, version-pinned`})`,
        asarEntries.has(m),
        'the require graph reaches it but the shipped asar has no such entry -- dead require at open')
    }
  }
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

// ── natives: this bundle carries ITS OWN platform's, and nobody else's ──────
// The v0.2.20 defect class, written down as a test.
//
// build.asarUnpack ships "node_modules/**" verbatim and electron-builder does
// no os/cpu filtering there, so the natives inside an artifact are exactly the
// natives the BUILD HOST installed -- while the Electron shell around them is
// downloaded for the TARGET and looks perfectly right. The published v0.2.20
// "x86_64" AppImage was built on this arm64 Mac and shipped
// @koromix/koffi-darwin-arm64, @img/sharp-darwin-arm64,
// @img/sharp-libvips-darwin-arm64, @vscode/ripgrep-darwin-arm64 and
// node-addon-require-builtin-darwin-arm64, with none of their linux-x64
// counterparts. An app in that state installs and boots, then dies at the
// first dsh file search (@vscode/ripgrep require.resolve -> SEARCH_FAILED),
// the first atomic write on Windows (koffi -> ReplaceFileW), or sandbox
// confine() on Linux (landlock-run absent, fails closed).
//
// scripts/assert-platform.mjs stops the wrong HOST from producing an artifact.
// This is the other half of the pair: it opens what was produced and says what
// is actually inside. Both halves are needed -- the assert cannot see a
// node_modules tree polluted by a forced `npm install --os=... --cpu=...`, and
// this gate cannot run before something has been built.
//
// The variant list is DERIVED from package-lock.json, never hand-typed. Every
// platform package carries npm's own `os`/`cpu` arrays in the lockfile, which
// is both the authoritative answer and the one that updates itself when dsh
// adds a platform next month. A hand-typed list would also get the families
// wrong in the direction that produces a FALSE FAIL: @img/sharp-libvips-* is
// published for darwin and linux and NOT for win32, where libvips is bundled
// inside @img/sharp-win32-x64 -- so "require sharp-libvips-<os>-<arch>" is
// only a real requirement where the lockfile says such a package exists.
const REQUIRED_NATIVE_FAMILIES = [
  ['@koromix/koffi',
    'dsh-fs-local (ReplaceFileW), dsh-session-persistence-jsonl (MoveFileExW), dsh-sandbox-windows-acl, dsh-host-directory-picker-native'],
  ['@img/sharp',
    'dsh-attachment-local imports sharp at module scope (it falls back to @img/sharp-wasm32, which loads everywhere and is slow -- a silent degradation, not a failure, which is exactly why it needs a gate)'],
  ['@img/sharp-libvips',
    "sharp's native libvips sidecar (published for darwin + linux; win32 bundles libvips inside @img/sharp-win32-x64)"],
  ['@vscode/ripgrep',
    "dsh-tool-fs-search does require.resolve('@vscode/ripgrep-<platform>-<arch>/bin/rg') -- a miss is SEARCH_FAILED at the first grep-class tool call"],
  ['@deepseek-ai/node-addon-landlock-run',
    'dsh-sandbox-local linux chain is bwrap -> landlock; with neither, confine() fails closed'],
]

// npm's own os/cpu matching, including the `!` negation form ("os": ["!win32"]).
function fieldAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true
  const negated = list.filter((x) => String(x).startsWith('!')).map((x) => String(x).slice(1))
  if (negated.includes(value)) return false
  const positive = list.filter((x) => !String(x).startsWith('!'))
  return positive.length ? positive.includes(value) : true
}

// Every package the lockfile declares as platform-bound, by name. Nested
// entries key as 'node_modules/a/node_modules/b' -- the package's own os/cpu
// facts do not depend on where it was hoisted to, so the last segment is the
// name and the first sighting wins.
function lockPlatformVariants() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const variants = new Map()
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || !entry) continue
    if (!entry.os && !entry.cpu) continue
    const at = key.lastIndexOf('node_modules/')
    if (at < 0) continue
    const name = key.slice(at + 'node_modules/'.length)
    if (!variants.has(name)) variants.set(name, { os: entry.os || null, cpu: entry.cpu || null })
  }
  return variants
}

// Walk an npm tree the way npm lays one out: a node_modules holds packages (or
// @scopes holding packages), and a package may hold its own nested
// node_modules. Only those two shapes are descended into, so this never walks
// into 500MB of package source looking for something that cannot be there.
function installedPackageNames(nodeModulesDir) {
  const found = new Set()
  const visit = (dir, depth) => {
    if (depth > 12) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (!e.isDirectory() && !e.isSymbolicLink()) continue
      if (e.name.startsWith('.')) continue // .bin, .package-lock.json
      if (e.name.startsWith('@')) {
        let scoped
        try { scoped = fs.readdirSync(path.join(dir, e.name), { withFileTypes: true }) } catch { continue }
        for (const s of scoped) {
          if (!s.isDirectory() && !s.isSymbolicLink()) continue
          found.add(`${e.name}/${s.name}`)
          visit(path.join(dir, e.name, s.name, 'node_modules'), depth + 1)
        }
      } else {
        found.add(e.name)
        visit(path.join(dir, e.name, 'node_modules'), depth + 1)
      }
    }
  }
  visit(nodeModulesDir, 0)
  return found
}

const TARGET_OS = { mac: 'darwin', win: 'win32', linux: 'linux' }[LANE]

function checkNatives(what, installed) {
  ok(`${what}: the package scan found something (a scan that finds nothing always passes)`,
    installed.size > 0, 'no package directories under that node_modules -- the walker or the path is wrong')
  const variants = lockPlatformVariants()
  ok('package-lock.json declares platform-bound packages to check against',
    variants.size > 0, 'no os/cpu-carrying entries in the lockfile -- the derivation is broken and every row below is vacuous')

  // PRESENT: the target's own.
  for (const [family, why] of REQUIRED_NATIVE_FAMILIES) {
    const wanted = `${family}-${TARGET_OS}-${LANE_ARCH}`
    if (!variants.has(wanted)) {
      console.log(`  n/a  ${wanted} -- package-lock.json publishes no such variant for ${TARGET_OS}-${LANE_ARCH}`)
      continue
    }
    ok(`${what} carries ${wanted}`, installed.has(wanted), why)
  }

  // ABSENT: everybody else's. Derived as "every platform-bound package in the
  // lockfile whose declared os/cpu cannot match this target".
  const foreign = [...variants.entries()]
    .filter(([, v]) => !(fieldAllows(v.os, TARGET_OS) && fieldAllows(v.cpu, LANE_ARCH)))
    .map(([name]) => name)
    .sort()
  const stowaways = foreign.filter((name) => installed.has(name))
  ok(`${what} carries NO other platform's native variants (${foreign.length} foreign variants known to the lockfile)`,
    stowaways.length === 0,
    `found ${stowaways.join(', ')} -- built on the wrong host, or npm installed with a forced --os/--cpu. ` +
    'This is the exact state the published 0.2.20 AppImage shipped in.')
}

console.log(`\n-- natives: does the ${LANE} bundle carry ${TARGET_OS}-${LANE_ARCH} and nothing else? (the 0.2.20 class)`)
if (IS_PREDIST) {
  // There is no bundle yet -- but there IS the tree asarUnpack is about to copy
  // verbatim, which is the only input that decides the answer. Checking it here
  // means a polluted install tree fails BEFORE a 4-minute build, and predist is
  // fail-hard like every other row in this file.
  checkNatives('repo node_modules (what asarUnpack will copy verbatim)', installedPackageNames(path.join(ROOT, 'node_modules')))
} else if (RUNNER_WITHOUT_LIVE) {
  console.log(`  SKIP  built-artifact natives gate -- needs a freshly built ${pkg.version} ${ARTIFACT_NOUN}; run \`npm test -- --live\` after a build, or \`${DIST_SCRIPT}\` (predist/postdist run this file fail-closed); NOT a pass`)
} else if (bundleNatives === null) {
  // The closure section above already failed loudly for whatever reason it
  // could not open the artifact; do not double-report it, but do not let the
  // natives question pass silently either.
  ok(`the ${LANE} bundle's app.asar.unpacked/node_modules could be read`, false,
    `${LANE === 'mac' ? 'the mounted DMG has no app.asar.unpacked/node_modules' : `no readable node_modules under ${path.relative(ROOT, path.join(STAGED_RESOURCES, 'app.asar.unpacked'))}`} (or the artifact above would not open) -- the natives in it are UNVERIFIED`)
} else {
  checkNatives(`the built ${LANE} bundle`, bundleNatives)
}

// ── node-pty: RETIRED (design-0023 P2, 2026-09-07) ──────────────────────────
// This file used to carry ~70 lines gating a native module that is no longer a
// dependency: the postinstall exec-bit repair, the helperPath double-replace
// patch in the repo tree AND in the artifact, the darwin-arm64 prebuild rows
// and the win32-x64 conpty rows. All of it guarded scripts/fix-pty-helper.mjs
// (deleted) and node-pty 1.1.0 (removed from package.json), whose ONE runtime
// caller was setup-token-session.cjs's pty login -- a lane superseded by
// in-app loopback OAuth in 0.2.18 and now refusing with `unsupported`.
//
// The rows are not replaced one-for-one, they are subsumed: the NATIVES gate
// above asks the same question of every native that actually ships (koffi,
// sharp + libvips, ripgrep, landlock) instead of the one that did not. Note
// what the old header claimed -- "the one native module" -- while dsh shipped
// five of them unguarded. That sentence was the bug.
//
// dsh's own nested node-pty (1.2.0-beta.15 under
// @deepseek-ai/dsh-subprocess-local, prebuilds for all six platforms including
// linux) is untouched and stays shipped; it is not a dependency of ours and
// nothing here should start gating it by hand.

console.log('\n-- claude CLI is NOT redistributed (license gate)')
{
  // These assertions are INVERTED from what they were until 2026-08-03. They
  // used to require that every artifact bundle
  // node_modules/@anthropic-ai/claude-code/bin/claude.exe -- i.e. the test
  // suite was mechanically enforcing the redistribution of a binary whose own
  // LICENSE.md reads "(c) Anthropic PBC. All rights reserved." with no
  // redistribution grant. A green suite is not evidence of a legal build; it
  // is only evidence that the build matches whatever the suite was told to
  // want. Now the suite wants the opposite, so re-bundling fails loudly here
  // instead of shipping quietly.
  //
  // The user installs Claude Code themselves (npm, from Anthropic) and
  // resolveClaudeBin() finds it on PATH. Automating that install on the
  // user's machine is fine -- the bytes travel Anthropic -> user and never
  // through our artifact. Copying them into our dmg is what was not.
  const entries = [
    ...(pkg.build.extraResources || []),
    ...((pkg.build.mac && pkg.build.mac.extraResources) || []),
    ...((pkg.build.win && pkg.build.win.extraResources) || []),
  ]
  const bundlesCli = entries.some((e) => String(e.from || '').includes('@anthropic-ai/claude-code'))
  ok('no build lane ships the claude-code binary', !bundlesCli,
    'redistributing an "All rights reserved" binary; the user installs it themselves')
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  ok('resolveClaudeBin does not look for a bundled copy', !mainSrc.includes("'claude-cli'"),
    'a resolver that still probes Resources/claude-cli invites the bundle back')
  ok('resolveClaudeBin searches npm global bin dirs', mainSrc.includes('NPM_GLOBAL_BIN_DIRS'),
    'a packaged app inherits a minimal PATH; PATH alone will miss an npm -g install')
}

console.log('\n-- the permission strings the OS shows the user')
const info = (pkg.build.mac && pkg.build.mac.extendInfo) || {}
ok('calendar full-access usage string is declared', typeof info.NSCalendarsFullAccessUsageDescription === 'string' && info.NSCalendarsFullAccessUsageDescription.length > 10,
  'without it macOS kills the process instead of prompting')
ok('...and it says we only READ', /읽/.test(info.NSCalendarsFullAccessUsageDescription || ''))

console.log('\n-- SCHEHERAZADE_MANUAL.md stays welded to the real option surface')
{
  // Why this test exists: on 2026-07-23 the sudo vault had shipped a week
  // earlier and the agent's prompt never mentioned it, so the agent tried
  // `sudo -n` (which can never reach an askpass helper), failed, and proposed
  // adding NOPASSWD to sudoers. The infrastructure was fine; nobody had told
  // the agent it existed. A manual written once and never revisited reproduces
  // that exact failure one level up -- silently, because a stale document
  // looks identical to a current one.
  //
  // So the manual is not trusted to stay true; it is checked. Every config key
  // the app WRITES is a switch a person can flip, which means it is something
  // the agent should be able to explain. Adding a switch without documenting it
  // now breaks the build instead of quietly widening the gap between what the
  // app can do and what the agent knows.
  const manualPath = path.join(ROOT, 'onboarding', 'templates', 'SCHEHERAZADE_MANUAL.md')
  ok('onboarding/templates/SCHEHERAZADE_MANUAL.md exists', fs.existsSync(manualPath),
    'the agent has no inventory of its own app without it')
  if (fs.existsSync(manualPath)) {
    const manual = fs.readFileSync(manualPath, 'utf8')
    // Keys that describe onboarding bookkeeping rather than a user-facing
    // choice. Everything else must appear in the manual by name or by the
    // plain-language label the agent would actually say out loud.
    // Per-channel home ids/names are recorded BY the channel connect flow, not
    // chosen as options -- the user picks a channel, these follow. Same class as
    // the onboarding step counters.
    const BOOKKEEPING = new Set([
      'ONBOARDING_COMPLETE', 'ONBOARDING_COMPLETED_AT', 'ONBOARDING_STEP',
      'HOME_GUILD_ID', 'HOME_GUILD_NAME', 'HOME_CHANNEL_NAME',
      'TELEGRAM_HOME_CHAT_ID', 'TELEGRAM_HOME_CHAT_NAME', 'TELEGRAM_BOT_USERNAME',
      'SLACK_HOME_CHANNEL_ID', 'SLACK_HOME_CHANNEL_NAME', 'SLACK_TEAM_NAME',
    ])
    // Plain-language stand-ins: the manual is read ALOUD to a non-technical
    // person, so requiring the raw key name in the prose would make it worse
    // to read in order to make it easier to test.
    const SPOKEN_AS = {
      DISPLAY_NAME: 'rename',
      CHANNEL_BACKEND: 'channels',
      AGENT_TOPOLOGY: 'Topology',
      EFFORT_LEVEL: 'effort level',
      SUDO_ENABLED: 'sudo',
      PROVIDER: 'provider',
      PROACTIVE: 'proactive',
      PROACTIVE_WINDOW_START: 'PROACTIVE_WINDOW_START',
      PROACTIVE_WINDOW_END: 'PROACTIVE_WINDOW_END',
    }
    const src = ['onboarding/http-server.cjs', 'main.cjs']
      .concat(fs.readdirSync(path.join(ROOT, 'onboarding', 'routes')).map((f) => `onboarding/routes/${f}`))
      .map((f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8') } catch { return '' } })
      .join('\n')
    const written = new Set()
    for (const m of src.matchAll(/writeAgentConfig\(\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/([A-Z][A-Z_]{2,})\s*:/g)) written.add(k[1])
    }
    const undocumented = [...written]
      .filter((k) => !BOOKKEEPING.has(k))
      .filter((k) => !manual.includes(SPOKEN_AS[k] || k))
    ok('every user-flippable config key is explained in the manual', undocumented.length === 0,
      `undocumented: ${undocumented.join(', ')} -- add it to docs/SCHEHERAZADE_MANUAL.md (or to BOOKKEEPING if it is not a user choice)`)
    // LAZY LOAD, not bake-in (Mino 2026-08-03 18:38): the prompt carries a
    // pointer and trigger phrases, the body stays on disk. Copied from Aside's
    // harness -- small always-loaded L1 (MEMORY.md/USER.md), everything else a
    // frontmatter page with `aliases` retrieved on demand. Baking the manual in
    // would spend context every single turn on something needed a few times a
    // month, and would make the prompt grow with every new option.
    const prompt = fs.readFileSync(path.join(ROOT, 'onboarding/templates/agent-system-prompt.md'), 'utf8')
    ok('the prompt POINTS at the manual', prompt.includes('SCHEHERAZADE_MANUAL.md'),
      'an agent that does not know the file exists will never read it')
    ok('the manual is NOT inlined into the prompt', !prompt.includes('## Danger zone'),
      'lazy-load it; a pasted copy both burns context every turn and rots separately from docs/')
    ok('the manual carries retrieval frontmatter (slug/title/aliases)',
      /^---\n[\s\S]*?slug:[\s\S]*?title:[\s\S]*?aliases:[\s\S]*?\n---/m.test(manual),
      'aliases are how a Korean phrasing finds an English page')
    // REACHABILITY, not just presence. The first build shipped this file in
    // docs/, which lands inside app.asar -- present in the artifact and
    // unopenable by the agent, since the agent is a separate `claude` process
    // reading real paths. Rendering it into the agent's data dir beside
    // CLAUDE.md is what actually makes it readable, so that is what gets
    // asserted; "the file exists in the repo" never implied the agent can read it.
    const harness = fs.readFileSync(path.join(ROOT, 'onboarding/harness-render.cjs'), 'utf8')
    ok('the manual is RENDERED into the agent data dir (not asar-trapped)',
      /renderHarness\([^)]*SCHEHERAZADE_MANUAL\.md/.test(harness),
      'a manual inside app.asar exists and cannot be opened by the agent')
    ok('the manual names the risk of the uninstall path', /uninstall/i.test(manual) && /memory/i.test(manual),
      'clean uninstall deletes the agent\'s memory; the agent must be able to say so before it runs')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
