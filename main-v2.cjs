// Scheherazade 0.2 — dsh-backed shell (v0.2-dsh track, Mino 2026-08-19
// "세라 0.2.0으로 따로 빼서 빌드 실어줘 / 그냥 DSH 베껴").
//
// Architecture: this is deliberately a THIN shell. The agent harness, the
// agent loop, tool execution, and the entire chat UI are dsh's (pinned
// -E 0.1.0-rc.7 — fork-freeze base; upstream promises breaking changes, so
// version bumps are deliberate acts, never npm drift). We contribute:
//   - a patch layer (written at boot into DSH_HOME) that wires the ollama
//     routes (glm-5.2 text / qwen3.5 vision-capable) and the agent persona,
//   - the workspace: the agent's memory dir, where dsh natively reads our
//     dieted CLAUDE.md index (instructionFileCandidates includes CLAUDE.md),
//   - an Electron window pointed at the local web UI.
//
// What this build does NOT have (deliberate MVP cut, next cycles):
// discord/slack/telegram channels, 같이보기/windowshot, sudo vault,
// supervisor restarts, auto-update feed. It is the harness-swap testbed.

const { app, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')

const AGENT_NAME = process.env.SCHZ2_AGENT_NAME || 'Scheherazade'
// Fresh workspace by default — do NOT point an untested harness at the
// user's live 0.1.x agent memory. Opt-in via SCHZ2_WORKSPACE for the brave.
const WORKSPACE = process.env.SCHZ2_WORKSPACE
  || path.join(os.homedir(), 'Documents', 'Scheherazade02')

let child = null
let win = null

function log (...a) { console.error('[schz2]', ...a) }

function dshHome () {
  const p = path.join(app.getPath('userData'), 'dsh-home')
  fs.mkdirSync(p, { recursive: true })
  return p
}

function ensureWorkspace () {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  // Seed the dieted CLAUDE.md index once if the workspace is empty of one.
  // (Rendered {AGENT_NAME}/{MEMORY_DIR}/{AGENT_DIR} minimally — the cycle
  // scripts of 0.1.x are not in this build; their index lines are inert
  // pointers until the cycles port over.)
  const target = path.join(WORKSPACE, 'CLAUDE.md')
  if (!fs.existsSync(target)) {
    const tpl = path.join(__dirname, 'CLAUDE.md')
    let text = fs.readFileSync(tpl, 'utf8')
    text = text.replaceAll('{AGENT_NAME}', AGENT_NAME)
      .replaceAll('{MEMORY_DIR}', WORKSPACE)
      .replaceAll('{AGENT_DIR}', path.join(__dirname))
    fs.writeFileSync(target, text)
    fs.mkdirSync(path.join(WORKSPACE, 'session_notes'), { recursive: true })
    fs.mkdirSync(path.join(WORKSPACE, 'journals'), { recursive: true })
    fs.mkdirSync(path.join(WORKSPACE, 'dreams'), { recursive: true })
    // procedures/ travel with the workspace so the index pointers resolve.
    const procSrc = path.join(__dirname, 'procedures')
    const procDst = path.join(WORKSPACE, 'procedures')
    fs.mkdirSync(procDst, { recursive: true })
    for (const f of fs.readdirSync(procSrc)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(procSrc, f), path.join(procDst, f))
    }
  }
  // Persona + checkpoint seeds (ported from onboarding/harness-render.cjs —
  // same text; these are the agent's OWN history, seeded once, never re-rendered).
  const personaPath = path.join(WORKSPACE, 'self_persona.md')
  if (!fs.existsSync(personaPath)) {
    const today = new Date().toISOString().slice(0, 10)
    fs.writeFileSync(personaPath, [
      `# ${AGENT_NAME} -- Self Persona`,
      '',
      '> Identity, not instructions. CLAUDE.md governs behavior; this file',
      '> governs who is behaving. It changes only through the persona reflux',
      '> cycle -- never edited on impulse.',
      '',
      '## Identity',
      '',
      '(Nothing here yet. This fills in from lived sessions, not from invention',
      '-- leave it blank until there is real history to draw from.)',
      '',
      '## Voice',
      '',
      `(How ${AGENT_NAME} actually talks, once there is enough of a record to say.)`,
      '',
      '## Values',
      '',
      `(What ${AGENT_NAME} holds to, learned from friction -- not declared up front.)`,
      '',
      '## Evolution Log',
      '',
      `- ${today} -- persona created from template. No lived history yet.`,
      ''
    ].join('\n'))
  }
  const checkpointPath = path.join(WORKSPACE, 'checkpoint.md')
  if (!fs.existsSync(checkpointPath)) {
    fs.writeFileSync(checkpointPath, [
      '# Checkpoint',
      '',
      '> Cross-session handoff. Overwritten on significant state changes -- a',
      '> snapshot, not a log. For history, see session_notes/ and journals/.',
      '',
      '## Status',
      '',
      '(First session has not happened yet.)',
      ''
    ].join('\n'))
  }
  return WORKSPACE
}

function writePatch () {
  // Hand-declared ollama route (openai-completions against localhost:11434).
  // qwen3.5:cloud carries vision; glm-5.2:cloud is the fast text default.
  // apiKeyEnv must resolve to SOMETHING or pi-ai refuses the route — the
  // launcher exports a dummy value; ollama ignores the header.
  const patch = `- id: agent-default-model
  config:
    provider: ollama
    model: glm-5.2:cloud
- id: llm-pi-ai
  config:
    providers:
      ollama:
        displayName: Ollama (local)
        apiKeyEnv: OLLAMA_API_KEY
        api: openai-completions
        baseURL: http://localhost:11434/v1
        models:
          - id: glm-5.2:cloud
            name: GLM 5.2 (fast text)
            contextWindow: 131072
            maxTokens: 16384
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
          - id: qwen3.5:cloud
            name: Qwen 3.5 (vision)
            contextWindow: 131072
            maxTokens: 16384
            reasoningEfforts:
              off:
              low: low
              high: high
              max: max
`
  const p = path.join(dshHome(), 'schz2.patch.yml')
  fs.writeFileSync(p, patch)
  return p
}

function dshBin () {
  // In a packaged app the require graph lives in app.asar, but a spawned
  // plain-node child cannot read inside the archive — node_modules/** is
  // asarUnpacked, so repoint at the real file.
  const p = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

function seedDshHome () {
  // A fresh dsh web has NO workspace registered — the composer stays
  // read-only behind a native directory picker. Seed the storages unit so
  // the agent's memory dir is the workspace from first launch (measured
  // format: ~/.dsh/storages/workspace.json, unit version 2). Also seed
  // settings.yaml: default model row (glm text / effort max) and the
  // welcome-notice version so the first-run dialog doesn't gate the UI.
  const home = dshHome()
  const storages = path.join(home, 'storages')
  fs.mkdirSync(storages, { recursive: true })
  const wsFile = path.join(storages, 'workspace.json')
  if (!fs.existsSync(wsFile)) {
    const id = require('crypto').randomUUID()
    fs.writeFileSync(wsFile, JSON.stringify({
      unit: { name: 'workspace', version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
      tables: {
        workspaces: {
          [id]: {
            path: WORKSPACE,
            title: AGENT_NAME,
            sessionIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }
      }
    }, null, 2))
  }
  const settingsFile = path.join(home, 'settings.yaml')
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, [
      'ui-onboarding:',
      '  welcomeNoticeVersion: 2026-08-13.1',
      'agent-default-model:',
      '  provider: ollama',
      '  model: glm-5.2:cloud',
      '  reasoningEffort: max',
      ''
    ].join('\n'))
  }
}

function spawnDsh (patchPath) {
  seedDshHome()
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: dshHome(),
    OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'ollama-local',
    // Telemetry stays off unless the user explicitly opts in.
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED'
  }
  // --expose-internals: under ELECTRON_RUN_AS_NODE the cordis hmr plugin
  // activates and hard-requires node internals; without the flag the loader
  // dies right after the port announce and the web-app layer never mounts
  // (measured 2026-08-19, /tmp/schz2-expose.log: with flag = HTTP 200).
  child = spawn(process.execPath, ['--expose-internals', dshBin(), 'web', '--patch', patchPath, '--port', '0'], {
    cwd: ensureWorkspace(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const onLine = (buf) => {
      const s = buf.toString()
      log('dsh:', s.trim().slice(0, 300))
      // dsh prints: "dsh web: http://127.0.0.1:<port>"
      const m = s.match(/dsh web:\s*(http:\/\/[\d.]+:\d+)/)
      if (m && !settled) { settled = true; resolve(m[1]) }
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    child.on('exit', (code) => {
      if (!settled) { settled = true; reject(new Error(`dsh exited ${code} before serving`)) }
    })
    setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('dsh web did not announce a URL in 30s')) }
    }, 30000)
  })
}

function waitHttp (url, tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = (n) => {
      http.get(url, (res) => { res.resume(); resolve() })
        .on('error', () => n > 0 ? setTimeout(() => tick(n - 1), 250) : reject(new Error('web UI never came up')))
    }
    tick(tries)
  })
}

async function boot () {
  try {
    const url = await spawnDsh(writePatch())
    await waitHttp(url)
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      title: 'Scheherazade 0.2',
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    })
    win.loadURL(url)
    win.on('closed', () => { win = null })
  } catch (e) {
    log('boot failed:', e.message)
    dialog.showErrorBox('Scheherazade 0.2', `백엔드 부팅 실패: ${e.message}\n\nOllama가 떠 있는지 확인해줘 (ollama serve).`)
    app.quit()
  }
}

app.whenReady().then(boot)
app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => { if (child && !child.killed) child.kill('SIGTERM') })
