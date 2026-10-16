#!/usr/bin/env node
// test-settings-import.mjs -- Settings > Import uses the same copy-into-store
// path as the onboarding step (0.3.6). Before this, Settings POSTed
// /api/migrate/start, which hands the agent the ORIGINAL roots to read in
// place: a later edit or deletion of the source changed what the app saw.
// What must hold:
//   - settings.js drives the shared picker (js/import-picker.js) off
//     /api/migrate/import/plan and no longer calls /detect or /start; the
//     wizard uses the same picker; both pages load the script before theirs;
//   - the picker, run against a stub DOM the way settings.js calls it, lists
//     one card per tool, leaves chat history unchecked, and its Copy click
//     POSTs exactly the checked paths to /api/migrate/import;
//   - over the real server: that POST copies into DATA_HOME/imported/<tool>/,
//     then deleting/editing the source leaves the copy intact;
//   - 0.3.7: Hand it over (custom folder + discover) uses the same copy flow:
//     /custom/plan + /discover/plan feed the picker, /import takes customRoots,
//     secrets are held back, broad roots refused; the legacy /custom/* sweep
//     routes and /detect + /start still answer;
//   - forced Stop has the same acknowledgement on every platform;
//   - the legacy /detect and /start routes still answer (nothing saved or
//     scripted against them breaks) and existing imported/ content survives.
//
// Hermetic: HOME redirected before the server loads.
// Run: node tests/test-settings-import.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-settings-import-'))
const require_ = createRequire(path.join(ROOT, 'package.json'))
const PUB = path.join(ROOT, 'onboarding', 'public')

let pass = 0
let fail = 0
function chk(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}
const read = (...p) => fs.readFileSync(path.join(PUB, ...p), 'utf8')

// ── source pins ─────────────────────────────────────────────────────────
const settingsSrc = read('js', 'settings.js')
const wizardSrc = read('js', 'wizard.js')
chk('settings.js: plans via /api/migrate/import/plan', settingsSrc.includes("'/api/migrate/import/plan'"))
chk('settings.js: renders through ImportPicker', settingsSrc.includes('window.ImportPicker.render('))
chk('settings.js: no longer calls the in-place /detect or /start', !settingsSrc.includes("'/api/migrate/detect'") && !settingsSrc.includes("'/api/migrate/start'"))
chk('settings.js: custom folder plans via /api/migrate/custom/plan', settingsSrc.includes("'/api/migrate/custom/plan'"))
chk('settings.js: discover plans via /api/migrate/discover/plan', settingsSrc.includes("'/api/migrate/discover/plan'"))
chk('settings.js: no in-place custom/discover sweeps left', !/\/api\/migrate\/custom\/(start|preview|discover)/.test(settingsSrc))
{
  const m = read('js', 'copy.js').match(/\n    stopped: ('[^']*'),\n    stopNoTurn/)
  chk('copy.js: forced Stop acknowledgement', !!m && vm.runInNewContext(m[1]) === 'Stopped.')
}
chk('wizard.js: same shared picker, no private copy of the POST', wizardSrc.includes('window.ImportPicker.render(') && !wizardSrc.includes("'/api/migrate/import'"))
for (const [page, script] of [['settings.html', 'settings.js'], ['index.html', 'wizard.js']]) {
  const html = read(page)
  const i = html.indexOf('/js/import-picker.js'), j = html.indexOf(`/js/${script}`)
  chk(`${page}: import-picker.js loads before ${script}`, i > 0 && j > i)
}

// ── picker against a stub DOM ───────────────────────────────────────────
function el(tag) {
  const e = {
    tag, children: [], className: '', textContent: '', checked: false, disabled: false, indeterminate: false,
    classList: { add() {}, remove() {} },
    appendChild(c) { e.children.push(c); return c },
    querySelectorAll(sel) {
      const out = []
      const walk = (n) => { for (const c of n.children || []) { if (c.tag === 'input') out.push(c); walk(c) } }
      walk(e)
      return sel === 'input' ? out : []
    },
  }
  let html = ''
  Object.defineProperty(e, 'innerHTML', { get: () => html, set: (v) => { html = v; e.children = [] } })
  return e
}
const win = {}
vm.runInNewContext(read('js', 'import-picker.js'), {
  window: win,
  document: { createElement: el, createTextNode: (t) => ({ tag: '#text', children: [], textContent: t }) },
})
const copyJs = read('js', 'copy.js')
// copy.js interpolates a platform layer, so lift just the step1b literal.
const T = (() => {
  const m = copyJs.match(/\n  step1b: (\{[\s\S]*?\n  \}),\n\n  step2:/)
  try { return m ? vm.runInNewContext(`(${m[1]})`) : null } catch { return null }
})()
chk('copy.js: step1b strings reachable for the settings surface', !!(T && typeof T.copy === 'function'))

let posted = null
const tools = [{
  id: 'hermes', label: 'Hermes', root: '/h', leftInPlace: [],
  items: [
    { path: 'SOUL.md', size: 10, kind: 'persona', defaultOn: true },
    { path: 'sessions/a.jsonl', size: 20, kind: 'transcript', defaultOn: false },
  ],
}]
const list = el('div'), copyBtn = el('button'), statusEl = el('div')
if (T) {
  win.ImportPicker.render({
    tools, T, GEN: (m) => m, list, copyBtn, statusEl,
    api: async (url, init) => { posted = { url, body: JSON.parse(init.body) }; return { copied: [{ path: 'SOUL.md' }], heldBack: [] } },
  })
  chk('picker: one card per tool', list.children.length === 1)
  chk('picker: Copy label counts only the default-on file', copyBtn.textContent === T.copy(1) && copyBtn.disabled === false, copyBtn.textContent)
  await copyBtn.onclick()
  chk('picker: Copy POSTs /api/migrate/import with only the checked path', posted && posted.url === '/api/migrate/import' && JSON.stringify(posted.body) === JSON.stringify({ selections: { hermes: ['SOUL.md'] } }), JSON.stringify(posted))
  chk('picker: works with no skip button (Settings has none)', statusEl.className.includes('success'), statusEl.className)
}

{
  const ctools = [{ id: 'custom-cadence-abc123', label: 'cadence', root: '/x/cadence', custom: true, leftInPlace: [], items: [{ path: 'persona.md', size: 5, kind: 'instructions', defaultOn: true }] }]
  const l2 = el('div'), b2 = el('button'), s2 = el('div')
  let p2 = null
  win.ImportPicker.render({ tools: ctools, T, GEN: (m) => m, list: l2, copyBtn: b2, statusEl: s2,
    api: async (url, init) => { p2 = JSON.parse(init.body); return { copied: [], heldBack: [] } } })
  await b2.onclick()
  chk('picker: custom folder sends its root as customRoots', p2 && p2.customRoots && p2.customRoots[0] === '/x/cadence' && p2.selections['custom-cadence-abc123'][0] === 'persona.md', JSON.stringify(p2))
}

// ── real server: copy, then the source changes ──────────────────────────
const fixtureHome = path.join(TMP, 'home')
fs.mkdirSync(fixtureHome, { recursive: true })
process.env.HOME = fixtureHome
if (process.platform === 'win32') process.env.USERPROFILE = fixtureHome
for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'OPENCLAW_PROFILE']) delete process.env[k]
const DATA = path.join(TMP, 'data')
process.env.AGENT_DATA_HOME = DATA
process.env.SCHEHERAZADE_MEMORY_DB = path.join(TMP, 'memory.db')
fs.mkdirSync(path.join(DATA, 'imported', 'claude'), { recursive: true })
fs.writeFileSync(path.join(DATA, 'imported', 'claude', 'earlier.md'), 'from the wizard\n')
const soul = path.join(fixtureHome, '.hermes', 'SOUL.md')
fs.mkdirSync(path.dirname(soul), { recursive: true })
fs.writeFileSync(soul, 'original soul\n')

const { createOnboardingServer, SERVER_TOKEN } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))
const srv = await createOnboardingServer()
const base = `http://127.0.0.1:${srv.server.address().port}`
try {
  const auth = { 'x-onboard-token': SERVER_TOKEN, 'content-type': 'application/json' }
  const plan = await (await fetch(`${base}/api/migrate/import/plan`, { headers: auth })).json()
  const h = plan.tools.find((t) => t.id === 'hermes')
  chk('server plan offers the fixture file', !!h && h.items.some((i) => i.path === 'SOUL.md'))
  const r = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: auth, body: JSON.stringify({ selections: { hermes: ['SOUL.md'] } }) })
  chk('import copies into the store', r.status === 200 && fs.readFileSync(path.join(DATA, 'imported', 'hermes', 'SOUL.md'), 'utf8') === 'original soul\n')
  fs.writeFileSync(soul, 'edited soul\n')
  chk('source edit does not change the copy', fs.readFileSync(path.join(DATA, 'imported', 'hermes', 'SOUL.md'), 'utf8') === 'original soul\n')
  fs.rmSync(path.dirname(soul), { recursive: true, force: true })
  chk('source deletion does not remove the copy', fs.existsSync(path.join(DATA, 'imported', 'hermes', 'SOUL.md')))
  chk('earlier imported content preserved', fs.readFileSync(path.join(DATA, 'imported', 'claude', 'earlier.md'), 'utf8') === 'from the wizard\n')
  // ── 0.3.7 custom folder through the copy flow ──
  const agentDir = path.join(TMP, 'work', 'cadence')
  fs.mkdirSync(path.join(agentDir, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(agentDir, 'persona.md'), 'I am Cadence\n')
  fs.writeFileSync(path.join(agentDir, 'notes', 'a.md'), 'likes tea\n')
  fs.writeFileSync(path.join(agentDir, 'notes', 'leak.md'), 'api_key = abcdefghijklmnop1234\n')
  fs.writeFileSync(path.join(agentDir, 'config.json'), '{"token":"SECRET-CFG"}')
  fs.writeFileSync(path.join(agentDir, 'auth.json'), 'SECRET-AUTH')
  const cp = await fetch(`${base}/api/migrate/custom/plan`, { method: 'POST', headers: auth, body: JSON.stringify({ root: agentDir }) })
  const cpb = await cp.json()
  const ct = cpb.tools && cpb.tools[0]
  chk('custom plan: one card, custom flag, md files only', cp.status === 200 && ct && ct.custom === true && ct.items.map((i) => i.path).sort().join() === 'notes/a.md,notes/leak.md,persona.md', JSON.stringify(cpb).slice(0, 200))
  chk('custom plan: config/credential files never offered', ct && !JSON.stringify(ct).includes('config.json') && !JSON.stringify(ct).includes('auth.json'))
  const bp = await fetch(`${base}/api/migrate/custom/plan`, { method: 'POST', headers: auth, body: JSON.stringify({ root: fixtureHome }) })
  chk('custom plan: broad root -> 400', bp.status === 400 && (await bp.json()).reason === 'root_too_broad')
  const ci = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: auth, body: JSON.stringify({ selections: { [ct.id]: ['persona.md', 'notes/a.md', 'notes/leak.md', 'config.json'] }, customRoots: [agentDir] }) })
  const cib = await ci.json()
  const cdir = path.join(DATA, 'imported', ct.id)
  chk('custom import: copies allowed files', ci.status === 200 && fs.readFileSync(path.join(cdir, 'persona.md'), 'utf8') === 'I am Cadence\n' && fs.existsSync(path.join(cdir, 'notes', 'a.md')))
  chk('custom import: secret-looking file held back, forged config.json dropped', !fs.existsSync(path.join(cdir, 'notes', 'leak.md')) && !fs.existsSync(path.join(cdir, 'config.json')) && cib.heldBack.some((x) => x.path === 'notes/leak.md'), JSON.stringify(cib.heldBack))
  const ci2 = await fetch(`${base}/api/migrate/import`, { method: 'POST', headers: auth, body: JSON.stringify({ selections: { [ct.id]: ['persona.md'] } }) })
  chk('custom import: id without its customRoots plans nothing', ci2.status === 200 && (await ci2.json()).copied.length === 0)
  const dp = await fetch(`${base}/api/migrate/discover/plan`, { headers: auth })
  chk('discover plan answers with a tools array', dp.status === 200 && Array.isArray((await dp.json()).tools))
  {
    const mi = require_(path.join(ROOT, 'memory', 'migrate-import.cjs'))
    const other = path.join(TMP, 'work', 'other')
    fs.mkdirSync(other, { recursive: true })
    fs.writeFileSync(path.join(other, 'SOUL.md'), 'soul\n')
    fs.mkdirSync(path.join(fixtureHome, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(fixtureHome, '.claude', 'AGENTS.md'), 'known tool home\n')
    fs.mkdirSync(path.join(DATA, 'own'), { recursive: true })
    fs.writeFileSync(path.join(DATA, 'own', 'persona.md'), 'own\n')
    const found = mi.discoverCandidates({
      home: fixtureHome, dataHome: DATA,
      find: () => [path.join(agentDir, 'persona.md'), path.join(other, 'SOUL.md'), path.join(fixtureHome, '.claude', 'AGENTS.md'), path.join(DATA, 'own', 'persona.md'), path.join(TMP, 'work', 'node_modules', 'x', 'persona.md')],
    })
    chk('discover: groups hits by folder, drops tool homes / own home / node_modules', found.map((t) => t.root).sort().join() === [agentDir, other].sort().join(), found.map((t) => t.root).join())
  }
  const d = await fetch(`${base}/api/migrate/detect`, { headers: auth })
  chk('legacy /detect still answers', d.status === 200)
  const s = await fetch(`${base}/api/migrate/start`, { method: 'POST', headers: auth, body: JSON.stringify({ tools: ['nope'] }) })
  chk('legacy /start still answers (forged id -> 400)', s.status === 400)
} finally {
  srv.server.close()
  try { (await import('file://' + path.join(ROOT, 'memory', 'service.mjs'))).close() } catch { /* absent in some layouts */ }
  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
