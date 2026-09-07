// test-skill-seeding.mjs — default-skill seeding (harness-render
// seedSkillDefinitions, v0.0.41).
//
// Pins the contract, not just the happy path:
//   1. templates/skills/*/SKILL.md all seed into CONFIG_DIR/.claude/skills
//      byte-identically, and every template's frontmatter `name:` matches
//      its directory name (Claude Code resolves skills by directory).
//   2. seed-if-absent per FILE: a user-edited skill survives a re-run
//      untouched; a genuinely new template still arrives on the same run.
//   3. no stray .tmp files left behind.
//   4. a template dir without SKILL.md is skipped, not an error.
//   5. design-0023 P4: the seeder asks onboarding/platform.cjs what this host
//      can run, and only that lands. Driven for darwin/win32/linux FROM ANY
//      HOST by injecting the capability table -- the mac branch was always
//      right, which is exactly why the bug (a Windows agent holding an
//      osascript calendar skill) was invisible from here.
//   6. the UPGRADE case, which is the one with a decision in it: an install
//      that already has those skills on disk from an older build. A shipped
//      file the user never touched (hash in skill-hashes.json) is retired; a
//      file the user edited, a file the user ADDED beside it, and legacy mode
//      with no manifest to prove pristineness are all left alone.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createHarnessRender } = require(path.join(REPO_ROOT, 'onboarding', 'harness-render.cjs'))

let ok = 0, bad = 0
const pass = (m) => { ok++; console.log(`  ok: ${m}`) }
const fail = (m) => { bad++; console.log(`  FAIL: ${m}`) }
const check = (cond, m) => (cond ? pass(m) : fail(m))

const TEMPLATE_SKILLS_DIR = path.join(REPO_ROOT, 'onboarding', 'templates', 'skills')
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sch-skill-seed-'))

try {
  // --- template sanity -------------------------------------------------
  console.log('template sanity')
  const templates = fs.readdirSync(TEMPLATE_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory()).map((e) => e.name).sort()
  check(templates.length >= 6, `at least 6 skill templates shipped (got ${templates.length}: ${templates.join(', ')})`)
  for (const name of templates) {
    const p = path.join(TEMPLATE_SKILLS_DIR, name, 'SKILL.md')
    if (!fs.existsSync(p)) { fail(`${name}/SKILL.md missing`); continue }
    const text = fs.readFileSync(p, 'utf8')
    const m = text.match(/^---\n([\s\S]*?)\n---/)
    if (!m) { fail(`${name}: no frontmatter block`); continue }
    const nameLine = m[1].match(/^name:\s*(\S+)\s*$/m)
    check(nameLine && nameLine[1] === name, `${name}: frontmatter name matches directory`)
    check(/^description:\s*\S/m.test(m[1]), `${name}: frontmatter has a description`)
  }

  // --- fresh seed -------------------------------------------------------
  console.log('fresh seed')
  const configDir = path.join(tmpRoot, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const harness = createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: configDir,
    DATA_HOME: path.join(tmpRoot, 'data'), AGENT_NAME: 'test',
  })
  harness.seedSkillDefinitions()
  const seededDir = path.join(configDir, '.claude', 'skills')
  for (const name of templates) {
    const target = path.join(seededDir, name, 'SKILL.md')
    if (!fs.existsSync(target)) { fail(`${name} not seeded`); continue }
    const same = fs.readFileSync(target, 'utf8') ===
      fs.readFileSync(path.join(TEMPLATE_SKILLS_DIR, name, 'SKILL.md'), 'utf8')
    check(same, `${name} seeded byte-identical`)
  }
  const strayTmp = fs.readdirSync(seededDir, { recursive: true })
    .filter((f) => String(f).endsWith('.tmp'))
  check(strayTmp.length === 0, 'no stray .tmp files after seeding')

  // --- edit survives, new template arrives, on the same re-run ---------
  console.log('re-run: edit preserved + new template arrives')
  const editedName = templates[0]
  const editedPath = path.join(seededDir, editedName, 'SKILL.md')
  fs.writeFileSync(editedPath, 'USER EDIT — must survive\n')
  // fake repo: copy real templates, add one new skill
  const fakeRepo = path.join(tmpRoot, 'fake-repo')
  const fakeSkills = path.join(fakeRepo, 'onboarding', 'templates', 'skills')
  fs.cpSync(TEMPLATE_SKILLS_DIR, fakeSkills, { recursive: true })
  fs.mkdirSync(path.join(fakeSkills, 'brand-new'), { recursive: true })
  fs.writeFileSync(path.join(fakeSkills, 'brand-new', 'SKILL.md'),
    '---\nname: brand-new\ndescription: arrived in a later version\n---\n# New\n')
  // and one malformed template dir with no SKILL.md — must be skipped
  fs.mkdirSync(path.join(fakeSkills, 'no-skill-md'), { recursive: true })
  const harness2 = createHarnessRender({
    log: () => {}, REPO_ROOT: fakeRepo, CONFIG_DIR: configDir,
    DATA_HOME: path.join(tmpRoot, 'data'), AGENT_NAME: 'test',
  })
  harness2.seedSkillDefinitions()
  check(fs.readFileSync(editedPath, 'utf8') === 'USER EDIT — must survive\n',
    'user-edited skill untouched by re-run')
  check(fs.existsSync(path.join(seededDir, 'brand-new', 'SKILL.md')),
    'new template from a later version arrives on re-run')
  check(!fs.existsSync(path.join(seededDir, 'no-skill-md')),
    'template dir without SKILL.md is skipped')

  // --- capability gate, all three platforms, from this Mac --------------
  // Expectations are SPELLED OUT per platform rather than derived from
  // skillAllowed(): a derivation agrees with any bug in the table, and the
  // point of this block is the product decision, not the expression.
  console.log('capability gate: only what the host can run')
  const caps = require(path.join(REPO_ROOT, 'onboarding', 'platform.cjs'))
  const mkHost = (platform, arch) => caps.capabilities({
    platform, arch, env: {},
    home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
    dataHome: platform === 'win32' ? 'C:\\Users\\t\\Documents\\Scheherazade' : '/home/t/Documents/Scheherazade',
    existsSync: () => false,
    accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    hasTmux: () => false,
  })
  // Apple-app automation, unix find/mv, window capture -- one row each.
  const WITHHELD = {
    darwin: [],
    win32: ['calendar', 'file-organizer', 'mail-briefing', 'reminders'],
    linux: ['calendar', 'mail-briefing', 'reminders', 'windowshot'],
  }
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    const cfg = path.join(tmpRoot, `gate-${platform}`)
    createHarnessRender({
      log: () => {}, REPO_ROOT, CONFIG_DIR: cfg,
      DATA_HOME: path.join(tmpRoot, `gate-data-${platform}`), AGENT_NAME: 'test',
      HOST: mkHost(platform, arch),
    }).seedSkillDefinitions()
    const seeded = fs.readdirSync(path.join(cfg, '.claude', 'skills')).sort()
    const expected = templates.filter((n) => !WITHHELD[platform].includes(n))
    check(seeded.join(',') === expected.join(','),
      `${platform}: seeds exactly ${expected.length} of ${templates.length} templates`)
    for (const name of WITHHELD[platform]) {
      check(!seeded.includes(name), `${platform}: ${name} is NOT seeded (the host cannot run it)`)
    }
    check(seeded.includes('coding') && seeded.includes('websearch'),
      `${platform}: a skill with no capability row is portable and still seeds`)
  }

  // --- upgrade: skills already on disk that this host cannot run --------
  // The case the gate alone does not fix. Seed as the old build did (every
  // skill, everywhere), then re-run as the new build on a Windows host --
  // which is what an app update on that machine actually is.
  console.log('upgrade: unsupported skills already installed')
  const upCfg = path.join(tmpRoot, 'upgrade-config')
  const upSkills = path.join(upCfg, '.claude', 'skills')
  createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: upCfg,
    DATA_HOME: path.join(tmpRoot, 'upgrade-data'), AGENT_NAME: 'test',
    HOST: mkHost('darwin', 'arm64'),
  }).seedSkillDefinitions()
  check(fs.existsSync(path.join(upSkills, 'calendar', 'SKILL.md')), 'old build seeded calendar on this install')
  // Three shapes of "already there", one per outcome.
  fs.writeFileSync(path.join(upSkills, 'reminders', 'SKILL.md'), 'MY OWN VERSION\n') // user-edited
  fs.writeFileSync(path.join(upSkills, 'calendar', 'my-notes.md'), 'my notes\n') // user-added sibling
  const winUpgrade = createHarnessRender({
    log: () => {}, REPO_ROOT, CONFIG_DIR: upCfg,
    DATA_HOME: path.join(tmpRoot, 'upgrade-data'), AGENT_NAME: 'test',
    HOST: mkHost('win32', 'x64'),
  })
  winUpgrade.seedSkillDefinitions()
  check(!fs.existsSync(path.join(upSkills, 'mail-briefing')),
    'a pristine unsupported skill is retired whole (leaving it would keep telling the agent it can read their mail)')
  check(!fs.existsSync(path.join(upSkills, 'file-organizer')),
    'the unix-tools skill is retired on Windows too')
  check(fs.readFileSync(path.join(upSkills, 'reminders', 'SKILL.md'), 'utf8') === 'MY OWN VERSION\n',
    'a user-EDITED unsupported skill is left exactly as it is (the manifest is what tells the two apart)')
  check(fs.readFileSync(path.join(upSkills, 'calendar', 'my-notes.md'), 'utf8') === 'my notes\n',
    'a file the user added beside a retired skill survives, and its directory with it')
  check(!fs.existsSync(path.join(upSkills, 'calendar', 'SKILL.md')),
    '...but the shipped SKILL.md next to it is still retired')
  check(fs.existsSync(path.join(upSkills, 'windowshot', 'SKILL.md')) && fs.existsSync(path.join(upSkills, 'coding', 'SKILL.md')),
    'supported and portable skills are untouched by the retirement pass')
  winUpgrade.seedSkillDefinitions()
  check(!fs.existsSync(path.join(upSkills, 'mail-briefing')) && fs.existsSync(path.join(upSkills, 'calendar', 'my-notes.md')),
    'the pass is idempotent: a second boot removes nothing new and throws nothing')

  // --- legacy mode: no manifest, no proof, no deletion ------------------
  // Same as the refresh side: without skill-hashes.json there is no way to
  // tell a shipped file from the user's own, so nothing is removed.
  console.log('upgrade under legacy mode (no manifest)')
  const legacyRepo = path.join(tmpRoot, 'legacy-repo')
  fs.cpSync(TEMPLATE_SKILLS_DIR, path.join(legacyRepo, 'onboarding', 'templates', 'skills'), { recursive: true })
  createHarnessRender({
    log: () => {}, REPO_ROOT: legacyRepo, CONFIG_DIR: upCfg,
    DATA_HOME: path.join(tmpRoot, 'upgrade-data'), AGENT_NAME: 'test',
    HOST: mkHost('linux', 'x64'),
  }).seedSkillDefinitions()
  check(fs.existsSync(path.join(upSkills, 'windowshot', 'SKILL.md')),
    'without a manifest an unsupported skill stays on disk (unprovable = untouched)')
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} ok, ${bad} failed`)
process.exit(bad ? 1 : 0)
