// test-skill-versioning.mjs — overwrite-if-pristine skill refresh (v0.1.11,
// harness-render refreshSkillFromFiles + scripts/gen-skill-hashes.mjs).
//
// Pins the contract:
//   1. MANIFEST FRESHNESS: onboarding/templates/skill-hashes.json exists,
//      schema 1, and contains the normalized hash of every CURRENT seeded
//      skill file (templates/skills + vendor/chromux/skills). Editing a
//      skill without re-running gen-skill-hashes.mjs fails the suite —
//      this is the enforcement hook that keeps the registry accumulating.
//   2. Tri-state on seed: pristine-but-stale installed copy (hash in
//      manifest) is auto-refreshed to the current template; a user-edited
//      copy (hash unknown) withholds the WHOLE skill; missing files seed.
//   3. CRLF normalization: a pristine old copy with Windows line endings
//      still counts as pristine (refresh fires, not withhold).
//   4. User-added extra files inside a skill dir survive a refresh.
//   5. Legacy mode (no manifest in REPO_ROOT): behaves as copy-if-missing —
//      any existing divergent copy is left alone.
//   6. chromux multi-file path: an edited topics/ file withholds the skill
//      on resync; a deleted topics/ file is reseeded.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createHarnessRender } = require(path.join(REPO_ROOT, 'onboarding', 'harness-render.cjs'))

let ok = 0, bad = 0
const pass = (m) => { ok++; console.log(`  ok: ${m}`) }
const fail = (m) => { bad++; console.log(`  FAIL: ${m}`) }
const check = (cond, m) => (cond ? pass(m) : fail(m))

const nhash = (buf) => crypto.createHash('sha256')
  .update(buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')).digest('hex')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-skill-ver-'))

try {
  // --- 1. manifest freshness against the real repo ----------------------
  console.log('manifest freshness')
  const manifestPath = path.join(REPO_ROOT, 'onboarding', 'templates', 'skill-hashes.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  check(manifest.schema === 1, 'manifest schema 1')
  const roots = [
    path.join(REPO_ROOT, 'onboarding', 'templates', 'skills'),
    path.join(REPO_ROOT, 'vendor', 'chromux', 'skills'),
  ]
  let covered = 0, stale = []
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const walk = (dir, rel) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) walk(path.join(dir, e.name), r)
        else if (e.isFile()) {
          covered++
          const h = nhash(fs.readFileSync(path.join(dir, e.name)))
          if (!Array.isArray(manifest.files[r]) || !manifest.files[r].includes(h)) stale.push(r)
        }
      }
    }
    walk(root, '')
  }
  check(covered > 0, `walked ${covered} shipped skill files`)
  check(stale.length === 0,
    stale.length ? `manifest STALE for: ${stale.join(', ')} — run scripts/gen-skill-hashes.mjs and commit` : 'every current skill file hash present in manifest')

  // --- 2-5. tri-state via a fake repo -----------------------------------
  console.log('tri-state seeding')
  const V1 = '---\nname: alpha\ndescription: v1\n---\nold body\n'
  const V2 = '---\nname: alpha\ndescription: v2\n---\nnew body\n'
  const fakeRepo = path.join(tmpRoot, 'fake-repo')
  const fakeSkills = path.join(fakeRepo, 'onboarding', 'templates', 'skills')
  for (const [name, text] of [['alpha', V2], ['beta', V2.replace(/alpha/g, 'beta')]]) {
    fs.mkdirSync(path.join(fakeSkills, name), { recursive: true })
    fs.writeFileSync(path.join(fakeSkills, name, 'SKILL.md'), text)
  }
  fs.writeFileSync(path.join(fakeRepo, 'onboarding', 'templates', 'skill-hashes.json'),
    JSON.stringify({
      schema: 1,
      files: {
        'alpha/SKILL.md': [nhash(Buffer.from(V1)), nhash(Buffer.from(V2))],
        'beta/SKILL.md': [nhash(Buffer.from(V2.replace(/alpha/g, 'beta')))],
      },
    }))
  const configDir = path.join(tmpRoot, 'config')
  const seededDir = path.join(configDir, '.claude', 'skills')
  // pre-install: alpha = pristine v1 with CRLF (covers case 3 in the same
  // pass), beta = user-edited, plus a user-added extra file next to alpha
  fs.mkdirSync(path.join(seededDir, 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(seededDir, 'alpha', 'SKILL.md'), V1.replace(/\n/g, '\r\n'))
  fs.writeFileSync(path.join(seededDir, 'alpha', 'my-notes.md'), 'user extra file\n')
  fs.mkdirSync(path.join(seededDir, 'beta'), { recursive: true })
  fs.writeFileSync(path.join(seededDir, 'beta', 'SKILL.md'), 'USER EDIT\n')
  const harness = createHarnessRender({
    log: () => {}, REPO_ROOT: fakeRepo, CONFIG_DIR: configDir,
    DATA_HOME: path.join(tmpRoot, 'data'), AGENT_NAME: 'test',
  })
  harness.seedSkillDefinitions()
  check(fs.readFileSync(path.join(seededDir, 'alpha', 'SKILL.md'), 'utf8') === V2,
    'pristine-but-stale copy (v1, CRLF) auto-refreshed to current template')
  check(fs.readFileSync(path.join(seededDir, 'alpha', 'my-notes.md'), 'utf8') === 'user extra file\n',
    'user-added extra file survives refresh')
  check(fs.readFileSync(path.join(seededDir, 'beta', 'SKILL.md'), 'utf8') === 'USER EDIT\n',
    'user-edited skill withheld from refresh')
  fs.rmSync(path.join(seededDir, 'alpha', 'SKILL.md'))
  harness.seedSkillDefinitions()
  check(fs.readFileSync(path.join(seededDir, 'alpha', 'SKILL.md'), 'utf8') === V2,
    'deleted skill file reseeded on next run')

  // --- 5. legacy mode: no manifest --------------------------------------
  console.log('legacy mode (no manifest)')
  const legacyRepo = path.join(tmpRoot, 'legacy-repo')
  fs.cpSync(fakeSkills, path.join(legacyRepo, 'onboarding', 'templates', 'skills'), { recursive: true })
  const legacyConfig = path.join(tmpRoot, 'legacy-config')
  const legacyDir = path.join(legacyConfig, '.claude', 'skills')
  fs.mkdirSync(path.join(legacyDir, 'alpha'), { recursive: true })
  fs.writeFileSync(path.join(legacyDir, 'alpha', 'SKILL.md'), V1) // stale but no manifest to prove it
  createHarnessRender({
    log: () => {}, REPO_ROOT: legacyRepo, CONFIG_DIR: legacyConfig,
    DATA_HOME: path.join(tmpRoot, 'legacy-data'), AGENT_NAME: 'test',
  }).seedSkillDefinitions()
  check(fs.readFileSync(path.join(legacyDir, 'alpha', 'SKILL.md'), 'utf8') === V1,
    'without manifest, divergent existing copy is left alone (copy-if-missing)')
  check(fs.existsSync(path.join(legacyDir, 'beta', 'SKILL.md')),
    'without manifest, missing skill still seeds')

  // --- 6. chromux multi-file path (real vendor + real manifest) ---------
  console.log('chromux multi-file refresh')
  const cxConfig = path.join(tmpRoot, 'cx-config')
  const cxData = path.join(tmpRoot, 'cx-data')
  const cx = createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: cxConfig,
    DATA_HOME: cxData, AGENT_NAME: 'test',
  })
  cx.syncChromuxPortable()
  const cxSkills = path.join(cxConfig, '.claude', 'skills')
  const topic = fs.readdirSync(path.join(cxSkills, 'chromux', 'topics'))[0]
  const topicPath = path.join(cxSkills, 'chromux', 'topics', topic)
  const topicOrig = fs.readFileSync(topicPath, 'utf8')
  // edited topics file -> whole skill withheld on resync
  fs.writeFileSync(topicPath, 'USER EDIT IN TOPIC\n')
  const skillMd = path.join(cxSkills, 'chromux', 'SKILL.md')
  fs.rmSync(skillMd) // even a missing sibling must NOT reseed while edited
  cx.syncChromuxPortable()
  check(fs.readFileSync(topicPath, 'utf8') === 'USER EDIT IN TOPIC\n',
    'edited topics file withholds chromux skill on resync')
  check(!fs.existsSync(skillMd), 'withheld skill does not reseed siblings either')
  // restore pristine -> resync heals both
  fs.writeFileSync(topicPath, topicOrig)
  cx.syncChromuxPortable()
  check(fs.existsSync(skillMd), 'pristine again: deleted SKILL.md reseeded on resync')
} catch (err) {
  fail(`unexpected throw: ${err.stack || err.message}`)
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} passed, ${bad} failed`)
if (bad > 0) process.exit(1)
