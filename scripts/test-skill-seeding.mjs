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
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log(`\n${ok} ok, ${bad} failed`)
process.exit(bad ? 1 : 0)
