// test-release-check.mjs -- the packaged-content check, with no build at all.
// Run: node tests/test-release-check.mjs
//
// tools/release-check.mjs is what now stands between "the preflight printed a
// HEAD" and "the app.asar a user downloads was built from that HEAD, in this
// run". The live half (a real dmg / win-unpacked / AppImage) only runs inside
// tools/release-all.mjs. This file builds FAKE asars with @electron/asar (the
// same library that reads the real ones) and drives the comparison through
// every way it has to fail, so the gate is proven to close before anyone
// trusts it to.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { STAMP_NAME, makeStamp, writeStamp, readPackagedFacts, compareFacts, readDmgFacts } from '../tools/release-check.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOL = path.join(ROOT, 'tools', 'release-check.mjs')

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-release-check-test-'))
const TAG = 'v9.8.7'
const HEAD = '0123456789abcdef0123456789abcdef01234567'
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98'
const RUN_ID = 'aaaaaaaa-1111-2222-3333-444444444444'

let n = 0
async function fakeAsar({ version = '9.8.7', stamp = makeStamp({ tag: TAG, head: HEAD, runId: RUN_ID }), extra = {} } = {}) {
  const src = path.join(TMP, `src-${++n}`)
  fs.mkdirSync(src, { recursive: true })
  if (version !== null) fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'scheherazade', version }))
  if (stamp) fs.writeFileSync(path.join(src, STAMP_NAME), typeof stamp === 'string' ? stamp : JSON.stringify(stamp))
  for (const [k, v] of Object.entries(extra)) fs.writeFileSync(path.join(src, k), v)
  const out = path.join(TMP, `app-${n}.asar`)
  await asar.createPackage(src, out)
  return out
}
const byName = (rows, re) => rows.find((r) => re.test(r.name))
const allOk = (rows) => rows.every((r) => r.ok)

try {
  console.log('\n-- the good case: a fresh asar of this run passes every row')
  {
    const a = await fakeAsar()
    const facts = readPackagedFacts(a, 'fake')
    ok('facts: asar opened', facts.error === null, facts.error)
    ok('facts: package.json version read out of the asar', facts.packageVersion === '9.8.7', facts.packageVersion)
    ok('facts: stamp read out of the asar', facts.stamp && facts.stamp.head === HEAD)
    const rows = compareFacts(facts, { tag: TAG, head: HEAD, runId: RUN_ID })
    ok('every row passes', allOk(rows), JSON.stringify(rows.filter((r) => !r.ok)))
    ok('six rows, always (logs of good and bad runs line up)', rows.length === 6, String(rows.length))
    ok('the run-id row was actually checked', !rows.some((r) => r.notChecked))
  }

  console.log('\n-- each way it must close')
  {
    const rowsFor = async (opts, expect = { tag: TAG, head: HEAD, runId: RUN_ID }) =>
      compareFacts(readPackagedFacts(await fakeAsar(opts), 'fake'), expect)

    let rows = await rowsFor({ version: '9.8.6' })
    ok('packaged version != tag -> FAIL', byName(rows, /version is 9\.8\.7/).ok === false)
    ok('... and the detail names what the asar said', /9\.8\.6/.test(byName(rows, /version is/).detail))

    rows = await rowsFor({ stamp: makeStamp({ tag: TAG, head: OTHER, runId: RUN_ID }) })
    ok('stamp head != preflight HEAD -> FAIL', byName(rows, /head is the preflight HEAD/).ok === false)

    rows = await rowsFor({ stamp: makeStamp({ tag: 'v9.8.6', head: HEAD, runId: RUN_ID }) })
    ok('stamp tag != tag -> FAIL', byName(rows, /tag is v9\.8\.7/).ok === false)

    rows = await rowsFor({ stamp: makeStamp({ tag: TAG, head: HEAD, runId: 'an-earlier-run' }) })
    ok('same commit, different run id (a stale artifact) -> FAIL', byName(rows, /run id is this run/).ok === false)
    ok('... and only that row fails', rows.filter((r) => !r.ok).length === 1)

    rows = await rowsFor({ stamp: null })
    ok('no stamp in the asar -> FAIL (present row)', byName(rows, /is present/).ok === false)
    ok('no stamp in the asar -> head row FAILs too, not vacuously ok', byName(rows, /head is the preflight/).ok === false)

    rows = await rowsFor({ stamp: '{not json' })
    ok('an unparseable stamp -> FAIL', byName(rows, /is present/).ok === false)

    rows = await rowsFor({ stamp: makeStamp({ tag: TAG, head: '', runId: RUN_ID }) }, { tag: TAG, head: '', runId: RUN_ID })
    ok('empty expected head never matches an empty stamped head', byName(rows, /head is the preflight/).ok === false)

    rows = await rowsFor({ version: null })
    ok('asar without package.json -> FAIL on open', byName(rows, /opens/).ok === false)
    ok('... and on version', byName(rows, /version is/).ok === false)

    const missing = readPackagedFacts(path.join(TMP, 'nope.asar'), 'fake')
    rows = compareFacts(missing, { tag: TAG, head: HEAD, runId: RUN_ID })
    ok('a missing asar -> every content row FAILs', rows.filter((r) => !r.ok).length === 6, JSON.stringify(rows))

    const garbage = path.join(TMP, 'garbage.asar')
    fs.writeFileSync(garbage, 'this is not an asar')
    rows = compareFacts(readPackagedFacts(garbage, 'fake'), { tag: TAG, head: HEAD, runId: RUN_ID })
    ok('a corrupt asar -> FAIL, never a throw', byName(rows, /opens/).ok === false)

    rows = compareFacts(null, { tag: TAG, head: HEAD, runId: RUN_ID })
    ok('no facts at all -> FAIL, never a throw', !allOk(rows))
  }

  console.log('\n-- --verify-only: no run id to hold it to')
  {
    const a = await fakeAsar({ stamp: makeStamp({ tag: TAG, head: HEAD, runId: 'whoever-built-it' }) })
    const rows = compareFacts(readPackagedFacts(a, 'fake'), { tag: TAG, head: HEAD, runId: null })
    const r = rows.find((x) => x.notChecked)
    ok('the run-id row is reported as NOT checked (not silently dropped)', !!r && /NOT checked/.test(r.name))
    ok('tag/head/version still enforced', allOk(rows))
    const bad = compareFacts(readPackagedFacts(await fakeAsar({ version: '1.0.0' }), 'fake'), { tag: TAG, head: HEAD, runId: null })
    ok('... and a wrong version still FAILs without a run id', !allOk(bad))
  }

  console.log('\n-- stamp: written from the tree, cross-checked against the run')
  {
    const repo = path.join(TMP, 'repo')
    fs.mkdirSync(repo)
    const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' })
    g('init', '-q')
    g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x')
    const head = g('rev-parse', 'HEAD').stdout.trim()
    const { stamp } = writeStamp({ dir: repo, tag: TAG, runId: RUN_ID, head })
    const onDisk = JSON.parse(fs.readFileSync(path.join(repo, STAMP_NAME), 'utf8'))
    ok('stamp carries the tree HEAD, tag, version and run id',
      onDisk.head === head && onDisk.tag === TAG && onDisk.version === '9.8.7' && onDisk.runId === RUN_ID, JSON.stringify(onDisk))
    ok('stamp returned == stamp written', stamp.head === onDisk.head)
    let threw = null
    try { writeStamp({ dir: repo, tag: TAG, runId: RUN_ID, head: OTHER }) } catch (e) { threw = e.message }
    ok('a tree at a different commit than the run expects refuses to stamp', !!threw && /refusing/.test(threw), threw)

    const bare = path.join(TMP, 'archive-tree')
    fs.mkdirSync(bare)
    threw = null
    try { writeStamp({ dir: bare, tag: TAG, runId: RUN_ID, useGit: false }) } catch (e) { threw = e.message }
    ok('no git and no --head -> refuses (no invented HEAD)', !!threw, threw)
    writeStamp({ dir: bare, tag: TAG, runId: RUN_ID, head: HEAD, useGit: false })
    ok('--no-git with --head writes the relayed HEAD (win lane: git archive tree)',
      JSON.parse(fs.readFileSync(path.join(bare, STAMP_NAME), 'utf8')).head === HEAD)
    threw = null
    try { writeStamp({ dir: bare, tag: TAG, runId: '', head: HEAD, useGit: false }) } catch (e) { threw = e.message }
    ok('no run id -> refuses', !!threw)
  }

  console.log('\n-- CLI dump: what the win/linux boxes run before cleanup')
  {
    const good = await fakeAsar()
    const out = path.join(TMP, 'dump-good.json')
    let r = spawnSync(process.execPath, [TOOL, 'dump', '--asar', good, '--source', 'fake', '--out', out, '--tag', TAG, '--head', HEAD, '--run-id', RUN_ID], { encoding: 'utf8' })
    ok('dump on a matching asar exits 0', r.status === 0, r.stdout + r.stderr)
    const dumped = JSON.parse(fs.readFileSync(out, 'utf8'))
    ok('dump JSON round-trips through compareFacts (what the driver does with it)',
      allOk(compareFacts(dumped, { tag: TAG, head: HEAD, runId: RUN_ID })))

    const stale = await fakeAsar({ stamp: makeStamp({ tag: TAG, head: HEAD, runId: 'old' }) })
    const out2 = path.join(TMP, 'dump-stale.json')
    r = spawnSync(process.execPath, [TOOL, 'dump', '--asar', stale, '--source', 'fake', '--out', out2, '--tag', TAG, '--head', HEAD, '--run-id', RUN_ID], { encoding: 'utf8' })
    ok('dump on a stale asar exits 1 (the remote leg fails loudly)', r.status === 1, `exit ${r.status}`)
    ok('... names the failing row', /FAIL\s+packaged BUILD_INFO\.json run id/.test(r.stdout), r.stdout)
    ok('... and still writes its evidence for the verify stage', fs.existsSync(out2))
  }

  console.log('\n-- mac: a dmg that is not there is a FAIL, not a skip')
  {
    const facts = readDmgFacts(path.join(TMP, 'Scheherazade-9.8.7-arm64.dmg'), 'Scheherazade')
    ok('missing dmg -> error facts', !!facts.error)
    ok('... which fail the open row', compareFacts(facts, { tag: TAG, head: HEAD, runId: RUN_ID })[0].ok === false)
  }

  console.log('\n-- wiring: the driver and the build config actually use it')
  {
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'release-all.mjs'), 'utf8')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    ok('build.files ships BUILD_INFO.json into app.asar', pkg.build.files.includes(STAMP_NAME))
    ok('BUILD_INFO.json is not unpacked (it must be INSIDE the asar that gets read)',
      !(pkg.build.asarUnpack || []).some((p) => p === STAMP_NAME || p.startsWith('BUILD_INFO')))
    ok('BUILD_INFO.json is gitignored (a committed stamp would vouch for every later build)',
      /^\/BUILD_INFO\.json$/m.test(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')))
    ok('release-all imports compareFacts from release-check', /import \{[^}]*compareFacts[^}]*\} from '\.\/release-check\.mjs'/.test(src))
    for (const lane of ['mac', 'win', 'linux']) {
      ok(`release-all verifies ${lane} packaged content`, src.includes(`verifyContent('${lane}'`))
    }
    const main = src.slice(src.indexOf('async function main()'))
    ok('the content rows run BEFORE publish (a failed row blocks --publish)',
      main.indexOf("verifyContent('mac'") > -1 && main.indexOf("verifyContent('mac'") < main.indexOf('await publish('))
    ok('publish still refuses on any failure', /if \(failures > 0\) \{\s*log\(`\\n  refusing to publish/.test(src))
    ok('the win build.cmd stamps before dist:win and dumps after it',
      /release-check\.mjs stamp --no-git[\s\S]*dist:win[\s\S]*release-check\.mjs dump/.test(src.slice(src.indexOf('function winCmdScript'), src.indexOf('async function legWin'))))
    ok('the WSL script stamps before dist:linux and dumps after it',
      /release-check\.mjs stamp[\s\S]*dist:linux[\s\S]*release-check\.mjs dump/.test(src.slice(src.indexOf('function wslShScript'), src.indexOf('async function legLinux'))))
    ok('the mac leg stamps before npm run dist',
      /'stamp'[\s\S]*\['run', 'dist'\]/.test(src.slice(src.indexOf('async function legMac'), src.indexOf('// ── lane: win'))))
    ok('the win check runs inside build.cmd, i.e. before the cleanup rmdir',
      src.indexOf('release-check.mjs dump') < src.indexOf("header('cleanup -- remote build directory')"))
  }
} finally {
  try { asar.uncacheAll() } catch { /* cache */ }
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
