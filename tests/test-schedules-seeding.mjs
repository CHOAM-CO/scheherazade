// test-schedules-seeding.mjs -- Dreaming feature (2026-08-16), the seeding
// half. Two separate contracts, both attacked over REAL artifacts:
//   1. hooks/session-start.mjs seeds DATA_HOME/schedules.json with the
//      default memory-consolidation entry -- absence-only, byte-for-byte
//      untouched if the file already exists (user/agent owns it once it's
//      there).
//   2. onboarding/harness-render.cjs renders procedures/memory-consolidation.md
//      into DATA_HOME the same way it renders the other 3 trigger-load
//      procedures (journal-compression.md / persona-reflux.md / madoromi.md).
//   3. design-0023 P4: the agent system prompt's {PLATFORM_SECTION} -- the one
//      part of that document that is a fact about the HOST rather than about
//      the agent. It used to be a section called "Controlling the Mac",
//      rendered verbatim on every platform, so a Windows agent was told to
//      drive Calendar.app with osascript. Three bodies now, and this drives
//      all three FROM THIS MAC by injecting the capability table, because the
//      darwin branch was never the broken one.
//
// Same runPorted/tmp shape as tests/test-hooks-port.mjs (which already
// owns the rest of session-start.mjs's contract) -- this file only adds the
// schedules-seeding assertions test-hooks-port.mjs does not cover, and does
// not duplicate its skill-listing / pending-compression / permission-wall
// coverage.
//
// Run: node tests/test-schedules-seeding.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let pass = 0
let fail = 0
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`) }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function runSessionStart(mem) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'session-start.mjs')],
    { env: { ...process.env, MEM: mem }, encoding: 'utf8' })
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status ?? 1 }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sched-seed-'))

// ── 1. fresh DATA_HOME -> schedules.json seeded ─────────────────────────────
console.log('-- schedules.json seeding: fresh DATA_HOME')
{
  const mem = tmp()
  const r = runSessionStart(mem)
  ok('session-start.mjs exits clean', r.code === 0, `code=${r.code} stderr=${r.stderr}`)
  const schedulesPath = path.join(mem, 'schedules.json')
  ok('schedules.json created', fs.existsSync(schedulesPath))
  let store
  try { store = JSON.parse(fs.readFileSync(schedulesPath, 'utf8')) } catch (err) { store = null; ok('schedules.json parses as JSON', false, err.message) }
  if (store) {
    ok('store version is 1', store.version === 1)
    // 0.2.12: madoromi joins memory-consolidation as a shipped default
    // (Mino 08-23 — dreams never fired on their own before; nothing
    // triggered the cycle CLAUDE.md promised for "idle stretches").
    ok('exactly two seeded entries', Array.isArray(store.schedules) && store.schedules.length === 2, JSON.stringify(store.schedules))
    const entry = Array.isArray(store.schedules) ? store.schedules.find((s) => s && s.id === 'memory-consolidation') : null
    ok('memory-consolidation entry present', !!entry)
    ok('enabled', entry && entry.enabled === true)
    ok('kind is recurring', entry && entry.kind === 'recurring')
    ok('everyMinutes is 1440 (daily)', entry && entry.everyMinutes === 1440)
    ok('window is 03:00-06:00', entry && entry.window === '03:00-06:00')
    ok('prompt points at the procedure file', entry && entry.prompt === 'Read procedures/memory-consolidation.md and follow it.', entry && entry.prompt)
    // Load-bearing: "agent" is the ONLY createdBy that rides the consent gate
    // in cadence/schedule-tick.cjs (isConsented / AUTONOMY=yes) instead of
    // bypassing it -- "system" would fire unsupervised with no consent at all.
    ok('createdBy is "agent" (rides the AUTONOMY=yes consent gate, never bypasses it)', entry && entry.createdBy === 'agent')
    ok('lastRunISO starts null', entry && entry.lastRunISO === null)
    const dream = Array.isArray(store.schedules) ? store.schedules.find((s) => s && s.id === 'madoromi') : null
    ok('madoromi entry present', !!dream)
    ok('madoromi enabled', dream && dream.enabled === true)
    ok('madoromi kind is recurring', dream && dream.kind === 'recurring')
    ok('madoromi everyMinutes is 1440 (daily)', dream && dream.everyMinutes === 1440)
    ok('madoromi window is 13:00-21:00 (first contact lands while the human is awake)', dream && dream.window === '13:00-21:00')
    ok('madoromi prompt names the solo script and the procedure file', dream && /madoromi-solo\.mjs/.test(dream.prompt) && /procedures\/madoromi\.md/.test(dream.prompt), dream && dream.prompt)
    ok('madoromi createdBy is "agent" (same consent gate as memory-consolidation)', dream && dream.createdBy === 'agent')
    ok('madoromi lastRunISO starts null', dream && dream.lastRunISO === null)
  }
  const stray = fs.readdirSync(mem).filter((f) => f.endsWith('.tmp') || f.includes('.tmp-'))
  ok('no stray .tmp files left behind by the atomic write', stray.length === 0, JSON.stringify(stray))
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── 2. existing schedules.json -> byte-for-byte untouched ──────────────────
console.log('-- schedules.json seeding: existing file is never touched')
{
  const mem = tmp()
  fs.mkdirSync(mem, { recursive: true })
  const existing = '{"version":1,"schedules":[{"id":"user-made","kind":"once","enabled":true,"prompt":"hi","createdBy":"user","atISO":"2030-01-01T00:00:00.000Z","lastRunISO":null}]}'
  fs.writeFileSync(path.join(mem, 'schedules.json'), existing)
  const r = runSessionStart(mem)
  ok('session-start.mjs exits clean', r.code === 0, `code=${r.code} stderr=${r.stderr}`)
  const after = fs.readFileSync(path.join(mem, 'schedules.json'), 'utf8')
  ok('existing schedules.json is byte-for-byte untouched (no merge, absence-only seeding)', after === existing)
  fs.rmSync(mem, { recursive: true, force: true })
}

// ── 3. procedure file rendered into DATA_HOME by harness-render.cjs ────────
console.log('-- procedures/memory-consolidation.md is harness-rendered like its 3 siblings')
{
  const srcPath = path.join(ROOT, 'procedures', 'memory-consolidation.md')
  ok('source file exists', fs.existsSync(srcPath))

  const renderSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'harness-render.cjs'), 'utf8')
  ok('the render list (same array as the other 3 procedures) includes memory-consolidation.md',
    /for \(const proc of \[[^\]]*'memory-consolidation\.md'[^\]]*\]\)/.test(renderSrc), 'render list literal not found or missing the entry')

  // Functional proof, not just the source-text pin above: actually run the
  // render (renderAgentSubstrate, the same function onboarding-complete and
  // boot-refresh both call) against a throwaway DATA_HOME and check the
  // rendered file lands with {AGENT_DIR}/{AGENT_NAME}/{MEMORY_DIR} resolved,
  // same as journal-compression.md gets.
  const { createHarnessRender } = require(path.join(ROOT, 'onboarding', 'harness-render.cjs'))
  const mem = tmp()
  const configDir = path.join(mem, 'config')
  fs.mkdirSync(configDir, { recursive: true })
  const harness = createHarnessRender({
    log: () => {},
    toUnpackedPath: (p) => p,
    readAgentConfig: () => ({}),
    ensureConfigDir: () => {},
    REPO_ROOT: ROOT,
    AGENT_NAME: 'TestAgent',
    DATA_HOME: mem,
    CONFIG_DIR: configDir,
    AGENT_CONFIG_PATH: path.join(configDir, '.agent-config'),
    ENV_PATH: path.join(configDir, '.env'),
    MCP_JSON_PATH: path.join(configDir, '.mcp.json'),
  })
  harness.renderAgentSubstrate({ displayName: 'TestAgent', tone: 'casual', primaryTask: '' })

  for (const proc of ['journal-compression.md', 'persona-reflux.md', 'madoromi.md', 'memory-consolidation.md']) {
    ok(`${proc} rendered into DATA_HOME/procedures`, fs.existsSync(path.join(mem, 'procedures', proc)))
  }
  const renderedMemCon = fs.readFileSync(path.join(mem, 'procedures', 'memory-consolidation.md'), 'utf8')
  const expected = fs.readFileSync(srcPath, 'utf8')
    .replaceAll('{AGENT_DIR}', ROOT)
    .replaceAll('{AGENT_NAME}', 'TestAgent')
    .replaceAll('{MEMORY_DIR}', mem)
  ok('rendered content matches source with placeholders resolved', renderedMemCon === expected)
  // The template writes `{AGENT_DIR}/scripts/...` with literal slashes, so the
  // rendered path is ROOT + forward slashes even where path.join backslashes.
  ok('rendered file points at the real journal-compress.mjs path', renderedMemCon.includes(`${ROOT}/scripts/journal-compress.mjs`))

  fs.rmSync(mem, { recursive: true, force: true })
}

// ── 4. the per-platform harness documents: three bodies each, and none of ──
//      them can lie about what the machine it is running on actually has.
//
//      {PLATFORM_SECTION} in the system prompt was the first of these. The
//      four documents asserted alongside it below were the tail of the same
//      bug: SCHEHERAZADE_MANUAL.md, procedures/machine.md, CLAUDE.md and
//      procedures/autonomy-and-paths.md are rendered into the agent's data
//      directory on EVERY host, and every one of them described `sudo -A`, a
//      Keychain vault, a tmux attach lane or an osascript skill set as a
//      universal fact. Driven from this Mac by injecting the capability
//      table, for the same reason: the darwin branch was never the broken one.
console.log('-- agent system prompt: {PLATFORM_SECTION} across darwin / win32 / linux')
{
  const templatePath = path.join(ROOT, 'onboarding', 'templates', 'agent-system-prompt.md')
  const template = fs.readFileSync(templatePath, 'utf8')
  ok('the template carries the {PLATFORM_SECTION} placeholder', template.includes('{PLATFORM_SECTION}'))
  ok('the hardcoded mac section is gone from the template', !template.includes('Controlling the Mac'),
    'a mac-only section rendered on every host is the bug this placeholder exists for')
  ok('the mac-only elevation mechanism is out of the platform-neutral Hard lines',
    !/^- Admin tasks: `sudo -A/m.test(template),
    'Windows has no sudo and no vault; the mechanism belongs in the per-platform body')

  const { createHarnessRender } = require(path.join(ROOT, 'onboarding', 'harness-render.cjs'))
  const platformMod = require(path.join(ROOT, 'onboarding', 'platform.cjs'))
  const GATED = Object.keys(platformMod.SKILL_REQUIREMENTS).sort()
  const mkHost = (platform, arch) => platformMod.capabilities({
    platform, arch, env: {},
    home: platform === 'win32' ? 'C:\\Users\\t' : '/home/t',
    dataHome: platform === 'win32' ? 'C:\\Users\\t\\Documents\\Scheherazade' : '/home/t/Documents/Scheherazade',
    existsSync: () => false,
    accessSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    hasTmux: () => false,
  })

  // Spelled out per platform, in the words the agent will actually read. The
  // absences matter as much as the presences: a Windows body that still says
  // "drive the app via osascript" is the original defect, and a mac body that
  // has grown a PowerShell caveat is the "one body with footnotes" this
  // deliberately is not.
  const EXPECT = {
    darwin: {
      title: '## Controlling this Mac',
      must: ['osascript', 'Apple Event', 'macOS Keychain', 'sudo -A <cmd>'],
      never: ['PowerShell', 'DPAPI', 'gnome-keyring', 'UAC'],
    },
    win32: {
      title: '## Controlling this PC',
      must: ['PowerShell', 'Get-ChildItem', 'Windows DPAPI', 'UAC'],
      never: ['drive the app via', 'Apple Event', 'macOS Keychain', 'gnome-keyring', 'sudo -A'],
    },
    linux: {
      title: '## Controlling this computer',
      must: ['POSIX shell', 'gnome-keyring', 'sudo -A <cmd>'],
      never: ['osascript', 'Apple Event', 'PowerShell', 'DPAPI', 'Keychain'],
    },
  }

  // The other four rendered documents. Same shape, same reason for the
  // `never` lists: what must be ABSENT is the half that was broken.
  //
  // The needles are phrases, not single words, on purpose. The manual's
  // uninstall section names macOS, Windows and Linux in one sentence
  // deliberately (all three uninstall paths are real and the agent has to
  // describe whichever one it is about to run), so a blanket "no Apple words
  // off darwin" gate would fail on correct prose. The cross-platform leak
  // check after the loop is the generic half that needs no needle at all.
  // src = where the template lives in the repo, out = where it lands in the
  // agent's data directory. They differ for the manual (the one document that
  // is a template rather than a file the repo also uses).
  const PLATFORM_DOCS = [
    { src: path.join('onboarding', 'templates', 'SCHEHERAZADE_MANUAL.md'), out: 'SCHEHERAZADE_MANUAL.md' },
    { src: 'CLAUDE.md', out: 'CLAUDE.md' },
    { src: path.join('procedures', 'machine.md'), out: path.join('procedures', 'machine.md') },
    { src: path.join('procedures', 'autonomy-and-paths.md'), out: path.join('procedures', 'autonomy-and-paths.md') },
  ]
  const DOC_EXPECT = {
    darwin: {
      'SCHEHERAZADE_MANUAL.md': {
        must: ['## Admin access (sudo)', '`sudo -A <cmd>`', '## macOS permissions',
          'Full Disk Access', 'external tmux session'],
        never: ['no elevation path', 'no permissions checklist', 'Windows DPAPI'],
      },
      'CLAUDE.md': {
        must: ['attach mode (user-run tmux bootstrap)', 'sudo = `sudo -A`'],
        never: ['no elevation lane', 'no attach lane'],
      },
      'procedures/machine.md': {
        must: ['`sudo -A <cmd>`', 'sealed with macOS Keychain', 'In attach mode you live in a tmux'],
        never: ['no elevation path', 'no durable mode'],
      },
      'procedures/autonomy-and-paths.md': {
        must: ['only via `sudo -A`'],
        never: ['no elevation lane'],
      },
    },
    win32: {
      'SCHEHERAZADE_MANUAL.md': {
        must: ['## Admin access', 'no elevation path on this PC', '## Permissions',
          'Windows DPAPI', 'One mode here'],
        // Deliberately NOT a bare 'Keychain': the uninstall section names the
        // mac, Windows and Linux teardown in one sentence on purpose, and that
        // sentence is correct on every host. The vacuity check after the loop
        // is what keeps this list from drifting into needles nobody writes.
        never: ['sudo -A', '## macOS permissions', 'Full Disk Access',
          'gnome-keyring', 'external tmux session'],
      },
      'CLAUDE.md': {
        must: ['no attach lane on this machine', 'No sudo and no elevation lane'],
        never: ['sudo -A', 'user-run tmux bootstrap'],
      },
      'procedures/machine.md': {
        must: ['there is no lane for it here', 'no durable mode'],
        never: ['sudo -A', 'Keychain', 'bootstrap command to paste'],
      },
      'procedures/autonomy-and-paths.md': {
        must: ['no elevation lane on this machine'],
        never: ['sudo -A'],
      },
    },
    linux: {
      'SCHEHERAZADE_MANUAL.md': {
        must: ['## Admin access (sudo)', '`sudo -A <cmd>`', '## Linux permissions',
          'gnome-keyring', 'One mode here'],
        never: ['## macOS permissions', 'Full Disk Access', 'Windows DPAPI',
          'external tmux session'],
      },
      'CLAUDE.md': {
        must: ['no attach lane on this machine', 'sudo = `sudo -A`'],
        never: ['user-run tmux bootstrap', 'no elevation lane'],
      },
      'procedures/machine.md': {
        must: ['`sudo -A <cmd>`', 'gnome-keyring', 'no durable mode'],
        never: ['Keychain', 'bootstrap command to paste'],
      },
      'procedures/autonomy-and-paths.md': {
        must: ['only via `sudo -A`'],
        never: ['no elevation lane'],
      },
    },
  }
  // Kept per platform so the vacuity check after the loop can ask the other
  // two hosts whether a `never` needle is a real absence or a typo.
  const renderedDocs = {}
  // Every block body, per platform, straight from the renderer -- so the leak
  // check below needs no hand-written needles and covers a block added next
  // year without anyone remembering this file.
  const blocksByPlatform = {}
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    blocksByPlatform[platform] = createHarnessRender({
      log: () => {}, toUnpackedPath: (p) => p, readAgentConfig: () => ({}), ensureConfigDir: () => {},
      REPO_ROOT: ROOT, AGENT_NAME: 'TestAgent', DATA_HOME: path.join(ROOT, 'no-such-dir'),
      CONFIG_DIR: path.join(ROOT, 'no-such-dir', 'config'),
      AGENT_CONFIG_PATH: '', ENV_PATH: '', MCP_JSON_PATH: '',
      HOST: mkHost(platform, arch),
    }).platformDocBlocks()
  }
  // A placeholder with no block renders as literal `{FOO}` into the agent's
  // data directory; a block no template carries is dead prose nobody reads.
  // Both directions, because the first is a visible defect and the second is
  // an invisible one.
  {
    const templates = PLATFORM_DOCS.map((d) => fs.readFileSync(path.join(ROOT, d.src), 'utf8')).join('\n')
    const GENERIC = new Set(['AGENT_DIR', 'AGENT_NAME', 'MEMORY_DIR', 'EXEC_PATH'])
    const used = new Set([...templates.matchAll(/\{([A-Z][A-Z_]{2,})\}/g)].map((m) => m[1])
      .filter((n) => !GENERIC.has(n)))
    const known = new Set(Object.keys(blocksByPlatform.darwin))
    const orphans = [...used].filter((n) => !known.has(n))
    const dead = [...known].filter((n) => !used.has(n))
    ok('every platform placeholder in the four documents has a block to fill it',
      orphans.length === 0, `${orphans.join(', ')} -- would render as literal text`)
    ok('every block platformDocBlocks() returns is actually used by a template',
      dead.length === 0, `${dead.join(', ')} -- written and never rendered`)
  }

  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64'], ['linux', 'x64']]) {
    const mem = tmp()
    const configDir = path.join(mem, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    const harness = createHarnessRender({
      log: () => {},
      toUnpackedPath: (p) => p,
      readAgentConfig: () => ({}),
      ensureConfigDir: () => {},
      REPO_ROOT: ROOT,
      AGENT_NAME: 'TestAgent',
      DATA_HOME: mem,
      CONFIG_DIR: configDir,
      AGENT_CONFIG_PATH: path.join(configDir, '.agent-config'),
      ENV_PATH: path.join(configDir, '.env'),
      MCP_JSON_PATH: path.join(configDir, '.mcp.json'),
      HOST: mkHost(platform, arch),
    })
    harness.renderAgentSubstrate({ displayName: 'TestAgent', tone: 'casual', primaryTask: '' })
    const prompt = fs.readFileSync(path.join(mem, 'system_prompt.md'), 'utf8')
    const spec = EXPECT[platform]

    ok(`${platform}: no raw placeholder survives the render`, !/\{[A-Z_]+\}/.test(prompt),
      (prompt.match(/\{[A-Z_]+\}/g) || []).join(' '))
    // Searched against the whitespace-flattened prompt: the document is
    // wrapped near 70 columns, so "macOS Keychain" legitimately straddles a
    // line break (same normalization test-identity-firewall.mjs uses on this
    // same file).
    const flatPrompt = prompt.replace(/\s+/g, ' ')
    ok(`${platform}: the section is titled "${spec.title}"`, prompt.includes(spec.title))
    for (const needle of spec.must) {
      ok(`${platform}: the prompt names ${JSON.stringify(needle)}`, flatPrompt.includes(needle))
    }
    for (const needle of spec.never) {
      ok(`${platform}: the prompt never says ${JSON.stringify(needle)}`, !flatPrompt.includes(needle),
        'another platform\'s body leaked in')
    }

    // The anti-drift property, and the reason the list is computed rather
    // than written: seed with the SAME capability table and the prompt's two
    // lists must match the disk exactly. A prompt that names a skill nobody
    // seeded is the same class of lie as the osascript section itself.
    harness.seedSkillDefinitions()
    const onDisk = GATED.filter((n) => fs.existsSync(path.join(configDir, '.claude', 'skills', n, 'SKILL.md')))
    const para = prompt.split('\n\n').find((b) => b.startsWith('Machine skills installed here:')) || ''
    const flat = para.replace(/\s+/g, ' ')
    const grab = (re) => { const m = flat.match(re); return m ? m[1].split(', ').filter(Boolean).sort() : [] }
    const listed = grab(/Machine skills installed here: ([^.]*)\./)
    const disowned = grab(/cannot run them: ([^.]*)\./)
    ok(`${platform}: the prompt lists exactly the gated skills that were seeded`,
      listed.join(',') === onDisk.join(','), `prompt=[${listed}] disk=[${onDisk}]`)
    ok(`${platform}: and names the ones that were withheld, so the agent cannot promise them`,
      disowned.join(',') === GATED.filter((n) => !onDisk.includes(n)).join(','),
      `prompt=[${disowned}] withheld=[${GATED.filter((n) => !onDisk.includes(n))}]`)

    // ── the other four documents, same render, same host ────────────────
    renderedDocs[platform] = {}
    for (const doc of PLATFORM_DOCS) {
      const key = doc.out.split(path.sep).join('/')
      const text = fs.readFileSync(path.join(mem, doc.out), 'utf8')
      const flatText = text.replace(/\s+/g, ' ')
      renderedDocs[platform][key] = flatText
      ok(`${platform}: ${key} keeps no raw placeholder`, !/\{[A-Z][A-Z_]{2,}\}/.test(text),
        (text.match(/\{[A-Z][A-Z_]{2,}\}/g) || []).join(' '))
      const spec = DOC_EXPECT[platform][key]
      for (const needle of spec.must) {
        ok(`${platform}: ${key} says ${JSON.stringify(needle)}`, flatText.includes(needle))
      }
      for (const needle of spec.never) {
        ok(`${platform}: ${key} never says ${JSON.stringify(needle)}`, !flatText.includes(needle),
          'another platform\'s body leaked in')
      }
    }
    // The generic half, over all four documents at once: this host's body for
    // every block landed WHOLE, and neither of the other two hosts' bodies is
    // anywhere in the set. No needle list to keep current -- a body reworded
    // next year is still covered, which is the property the spelled-out lists
    // above cannot have.
    {
      const all = PLATFORM_DOCS.map((d) => fs.readFileSync(path.join(mem, d.out), 'utf8')).join('\n')
      for (const [name, body] of Object.entries(blocksByPlatform[platform])) {
        ok(`${platform}: the ${name} body reached a rendered document intact`, all.includes(body))
        for (const other of ['darwin', 'win32', 'linux']) {
          if (other === platform) continue
          const foreign = blocksByPlatform[other][name]
          if (foreign === body) continue // the two hosts genuinely share this one fact
          ok(`${platform}: the ${other} body for ${name} is nowhere in the rendered set`,
            !all.includes(foreign), 'a foreign platform body was rendered here')
        }
      }
    }

    fs.rmSync(mem, { recursive: true, force: true })
  }
  // A `never` needle for a phrase no host ever writes is a green row that
  // proves nothing -- the same "a gate whose subject does not exist passes
  // vacuously" trap tools/test-packaging.mjs guards for its forbidden dirs.
  // Every absence asserted above has to be a real presence somewhere else.
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const key of Object.keys(DOC_EXPECT[platform])) {
      for (const needle of DOC_EXPECT[platform][key].never) {
        const elsewhere = ['darwin', 'win32', 'linux']
          .filter((p) => p !== platform)
          .some((p) => renderedDocs[p][key].includes(needle))
        ok(`${platform}: the absence of ${JSON.stringify(needle)} in ${key} is real (another host writes it)`,
          elsewhere, 'no host writes this phrase -- the row passes vacuously')
      }
    }
  }
  // Linux's windowCapture is a host probe (wmctrl/xdotool + import), so the
  // body must ASK it, not assert its absence: on a box with those packages
  // the skill is seeded, and a prompt still saying the machine cannot
  // photograph a window would talk the agent out of work it can do.
  {
    const mem = tmp()
    const configDir = path.join(mem, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    const harness = createHarnessRender({
      log: () => {}, toUnpackedPath: (p) => p, readAgentConfig: () => ({}), ensureConfigDir: () => {},
      REPO_ROOT: ROOT, AGENT_NAME: 'TestAgent', DATA_HOME: mem, CONFIG_DIR: configDir,
      AGENT_CONFIG_PATH: path.join(configDir, '.agent-config'),
      ENV_PATH: path.join(configDir, '.env'),
      MCP_JSON_PATH: path.join(configDir, '.mcp.json'),
      HOST: platformMod.capabilities({
        platform: 'linux', arch: 'x64', env: {}, home: '/home/t', dataHome: '/home/t/d',
        existsSync: () => true, accessSync: () => {}, hasTmux: () => false,
      }),
    })
    harness.renderAgentSubstrate({ displayName: 'TestAgent', tone: 'casual', primaryTask: '' })
    harness.seedSkillDefinitions()
    const flat = fs.readFileSync(path.join(mem, 'system_prompt.md'), 'utf8').replace(/\s+/g, ' ')
    ok('linux with capture tools: the prompt drops the "cannot photograph a window" clause',
      !flat.includes('no way to photograph a window'))
    ok('linux with capture tools: windowshot is listed as installed, and it is on disk',
      /Machine skills installed here: [^.]*windowshot/.test(flat)
        && fs.existsSync(path.join(configDir, '.claude', 'skills', 'windowshot', 'SKILL.md')))
    fs.rmSync(mem, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
