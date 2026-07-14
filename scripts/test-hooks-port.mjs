// test-hooks-port.mjs -- the bash->node port of the 3 hooks + 3 cycle
// scripts (win-port Phase 3) actually behaves like the bash it replaced.
// Run: node scripts/test-hooks-port.mjs
//
// Each section runs the REAL ported file as a child process against a temp
// MEM and attacks the behavior the bash version was load-bearing for --
// including the two boot-test lessons welded into persona-reflux (line-lead
// 🔒 anchor; file:line key discipline) and felt-check's under-50-chars
// threshold. The wiring section makes the deletion of the .sh originals
// stick: a resurrected bash reference in the template or CLAUDE.md fails
// loudly here.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// stderr captured separately -- the cycle scripts talk to the agent on
// stdout and to the operator on stderr, same split as the bash versions.
// spawnSync, NOT execFileSync: execFileSync's success path returns stdout
// only and lets stderr INHERIT, so every stderr assertion read '' while the
// text printed to the test runner's own terminal (first run of this suite
// convicted three innocent ports exactly that way).
function runPorted(rel, mem, args = []) {
  const r = spawnSync(process.execPath, [path.join(ROOT, rel), ...args],
    { env: { ...process.env, MEM: mem }, encoding: 'utf8' })
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 1 }
}
const runPortedFull = runPorted
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-port-'))

// ── wiring: bash is actually GONE ───────────────────────────────────────────
console.log('\n-- wiring: the .sh originals are gone and nothing still points at them')
{
  const dead = ['hooks/session-start.sh', 'hooks/felt-check.sh', 'hooks/checkpoint-nudge.sh',
    'scripts/journal-compress.sh', 'scripts/madoromi-solo.sh', 'scripts/persona-reflux.sh']
  for (const f of dead) ok(`${f} deleted`, !fs.existsSync(path.join(ROOT, f)))
  const template = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'claude-settings.local.json'), 'utf8')
  ok('settings template has NO bash hook commands', !template.includes('bash {AGENT_DIR}'))
  ok('settings template wires the 3 ported hooks via node',
    ['session-start.mjs', 'felt-check.mjs', 'checkpoint-nudge.mjs'].every((f) => template.includes(`node {AGENT_DIR}/hooks/${f}`)))
  const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8')
  ok('CLAUDE.md invokes the cycle scripts as node .mjs (no stale .sh instructions)',
    !/scripts\/(journal-compress|persona-reflux|madoromi-solo)\.sh/.test(claudeMd) &&
    claudeMd.includes('node {AGENT_DIR}/scripts/journal-compress.mjs scan'))
}
{
  // EXISTING installs: seedSettingsLocal is seed-if-absent, so without a
  // migration their settings keep saying `bash .../session-start.sh` after
  // the .sh files are deleted -- the boot restore summary dies silently
  // ("disk updated, config frozen" class, diagnosed live 07-13). The
  // migration regex is extracted from http-server.cjs SOURCE and executed
  // here -- testing the actual rule, not a copy of it.
  const httpSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  const m = httpSrc.match(/const BASH_HOOK_PORT = \/(.+)\/\n/)
  ok('http-server carries the bash-hook port migration', Boolean(m))
  if (m) {
    const rx = new RegExp(m[1])
    ok('migration matches the exact seeded bash shape',
      rx.test('bash /Applications/S.app/Contents/Resources/app.asar.unpacked/hooks/session-start.sh') &&
      rx.test('bash /some/repo/hooks/felt-check.sh') && rx.test('bash /some/repo/hooks/checkpoint-nudge.sh'))
    ok('migration leaves hand-edited variants alone (extra args / other files / node commands)',
      !rx.test('bash /x/hooks/session-start.sh --flag') && !rx.test('bash /x/hooks/my-custom.sh') &&
      !rx.test('node /x/hooks/session-start.mjs'))
  }
}

// ── session-start ───────────────────────────────────────────────────────────
console.log('\n-- session-start.mjs')
{
  const mem = tmp()
  // yesterday's note with no journal -> pending; a skill with a frontmatter
  // trigger AND a decoy body "trigger:" line (must not be picked up).
  fs.mkdirSync(path.join(mem, 'session_notes'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'session_notes', '2020-01-01.md'), 'old note')
  fs.mkdirSync(path.join(mem, 'skills'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'skills', 'sample.md'),
    '---\nname: sample\ntrigger: "when the moon is full"\n---\nbody text\ntrigger: NOT THIS ONE\n')
  const { stdout } = runPorted('hooks/session-start.mjs', mem)
  const parsed = JSON.parse(stdout) // throws = fail loud
  const ctx = parsed.hookSpecificOutput.additionalContext
  ok('emits valid hookSpecificOutput JSON for SessionStart', parsed.hookSpecificOutput.hookEventName === 'SessionStart')
  ok('creates today\'s note with the Felt template', fs.readFileSync(path.join(mem, 'session_notes', `${TODAY}.md`), 'utf8').includes('## 🔥 Felt'))
  ok('reports the note as created fresh', ctx.includes('created fresh'))
  ok('counts the prior-date note as pending compression', ctx.includes('1 prior-date session note(s)'))
  ok('...and points at the PORTED compress script', ctx.includes('journal-compress.mjs scan'))
  ok('skill listing reads the FRONTMATTER trigger', ctx.includes('sample.md: when the moon is full'))
  ok('...and never the body decoy', !ctx.includes('NOT THIS ONE'))
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── felt-check ──────────────────────────────────────────────────────────────
console.log('\n-- felt-check.mjs')
{
  const mem = tmp()
  const notes = path.join(mem, 'session_notes')
  fs.mkdirSync(notes, { recursive: true })
  const noteFile = path.join(notes, `${TODAY}.md`)

  let r = runPorted('hooks/felt-check.mjs', mem)
  ok('missing note -> silent exit 0', r.code === 0 && r.stdout.trim() === '')

  fs.writeFileSync(noteFile, '# note\n\n## Handoff\n')
  r = runPorted('hooks/felt-check.mjs', mem)
  ok('no Felt heading -> nudges for the section', r.stdout.includes('No ## 🔥 Felt'))

  fs.writeFileSync(noteFile, '# note\n\n## 🔥 Felt\nshort\n\n## Handoff\nlots of handoff text that must not count toward the felt length at all\n')
  r = runPorted('hooks/felt-check.mjs', mem)
  ok('thin Felt (next-section text does NOT count) -> thin nudge', r.stdout.includes('thin'))

  fs.writeFileSync(noteFile, `# note\n\n## 🔥 Felt\n${'실제 장면이 여기 들어간다 '.repeat(5)}\n\n## Handoff\n`)
  r = runPorted('hooks/felt-check.mjs', mem)
  ok('substantive Felt -> silent', r.stdout.trim() === '', r.stdout)
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── checkpoint-nudge ────────────────────────────────────────────────────────
console.log('\n-- checkpoint-nudge.mjs')
{
  const mem = tmp()
  const cp = path.join(mem, 'checkpoint.md')

  let r = runPorted('hooks/checkpoint-nudge.mjs', mem)
  ok('no checkpoint file -> silent', r.stdout.trim() === '')

  fs.writeFileSync(cp, 'state')
  r = runPorted('hooks/checkpoint-nudge.mjs', mem)
  ok('fresh checkpoint -> silent', r.stdout.trim() === '')

  const past = new Date(Date.now() - 2000 * 1000) // 33min ago
  fs.utimesSync(cp, past, past)
  r = runPorted('hooks/checkpoint-nudge.mjs', mem)
  ok('33min-stale checkpoint -> nudge with the age', r.stdout.includes('33min'), r.stdout)
  ok('throttle marker written', fs.existsSync(path.join(mem, '.last_checkpoint_nudge')))

  r = runPorted('hooks/checkpoint-nudge.mjs', mem)
  ok('immediate second stop -> throttled silent', r.stdout.trim() === '')
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── journal-compress ────────────────────────────────────────────────────────
console.log('\n-- journal-compress.mjs')
{
  const mem = tmp()
  fs.mkdirSync(path.join(mem, 'session_notes'), { recursive: true })
  fs.mkdirSync(path.join(mem, 'journals'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'session_notes', '2020-01-01.md'), 'journaled old note')
  fs.writeFileSync(path.join(mem, 'session_notes', '2020-01-02.md'), 'UNjournaled old note')
  fs.writeFileSync(path.join(mem, 'session_notes', `${TODAY}.md`), 'today, never touched')
  fs.writeFileSync(path.join(mem, 'journals', '2020-01-01.md'), 'its journal entry')

  let r = runPortedFull('scripts/journal-compress.mjs', mem, ['scan'])
  ok('scan lists ONLY the unjournaled old note', r.stdout.includes('2020-01-02.md') && !r.stdout.includes('2020-01-01.md') && !r.stdout.includes(`${TODAY}.md`), r.stdout)

  r = runPortedFull('scripts/journal-compress.mjs', mem, ['archive'])
  ok('archive moves ONLY the journaled note', fs.existsSync(path.join(mem, 'session_notes', '.archive', '2020-01-01.md')) && !fs.existsSync(path.join(mem, 'session_notes', '2020-01-01.md')))
  ok('unjournaled note left alone (never silently lost)', fs.existsSync(path.join(mem, 'session_notes', '2020-01-02.md')))
  ok('today\'s note untouched', fs.existsSync(path.join(mem, 'session_notes', `${TODAY}.md`)))
  ok('.last_compress stamped', fs.existsSync(path.join(mem, '.last_compress')))

  r = runPortedFull('scripts/journal-compress.mjs', mem, ['bogus-mode'])
  ok('unknown mode -> usage + exit 1', r.code === 1)
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── persona-reflux ──────────────────────────────────────────────────────────
console.log('\n-- persona-reflux.mjs (the two boot-test lessons must survive the port)')
{
  const mem = tmp()
  fs.mkdirSync(path.join(mem, 'session_notes'), { recursive: true })
  // ONE file only (the bash -H lesson's trigger condition), containing a
  // line-lead 🔒, a bulleted 🔒, and a mid-line decoy.
  fs.writeFileSync(path.join(mem, 'session_notes', '2020-01-03.md'),
    'prose mentioning 🔒 lines below in passing\n- 🔒 real correction one\n  🔒 real correction two\n')
  let r = runPortedFull('scripts/persona-reflux.mjs', mem)
  const proposals = fs.readFileSync(path.join(mem, '.review', 'reflux-proposals.md'), 'utf8')
  ok('line-lead 🔒 lines proposed (bulleted + indented)', proposals.includes('real correction one') && proposals.includes('real correction two'))
  ok('LESSON 1: mid-line 🔒 mention is NOT a correction', !proposals.includes('lines below in passing'))
  ok('marker stripped from the correction text', !proposals.includes('**Correction**: - 🔒'))
  const seen = fs.readFileSync(path.join(mem, '.review', '.reflux-seen'), 'utf8').trim().split('\n')
  ok('LESSON 2: single-file run still keys as file:line', seen.every((k) => /session_notes\/2020-01-03\.md:\d+$/.test(k)), JSON.stringify(seen))
  ok('reported 2 new corrections', r.stderr.includes('2 new correction(s)'), r.stderr)

  r = runPortedFull('scripts/persona-reflux.mjs', mem)
  ok('re-run dedupes to 0 (idempotent)', r.stderr.includes('0 new correction(s)'), r.stderr)
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── madoromi-solo ───────────────────────────────────────────────────────────
console.log('\n-- madoromi-solo.mjs')
{
  const mem = tmp()
  let r = runPortedFull('scripts/madoromi-solo.mjs', mem)
  ok('no journals -> says so and exits 0', r.code === 0 && r.stderr.includes('nothing to dream from'))

  fs.mkdirSync(path.join(mem, 'journals'), { recursive: true })
  fs.writeFileSync(path.join(mem, 'journals', '2020-02-01.md'), 'the harbor crane entry')
  r = runPortedFull('scripts/madoromi-solo.mjs', mem)
  ok('prints the frame with the picked entry inline', r.stdout.includes('[MADOROMI]') && r.stdout.includes('the harbor crane entry') && r.stdout.includes('--- 2020-02-01.md ---'))
  ok('names the dream target for today', r.stdout.includes(path.join('dreams', `${TODAY}.md`)))
  ok('sources line carries the basenames', r.stdout.includes('Sources: 2020-02-01.md'))
  fs.rmSync(mem, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
