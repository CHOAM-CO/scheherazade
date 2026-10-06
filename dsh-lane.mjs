#!/usr/bin/env node
// dsh-lane.mjs -- the dsh flavor of headless-lane.mjs (0.2.1 junction).
//
// Drop-in for the lane seam: everything upstream (channel-local/discord/
// slack/telegram connectors, chat routes, supervisor) keeps its contract:
//   IN : POST 127.0.0.1:<port>/inbound {content, meta} + x-ingest-token,
//        endpoint published at MEM/.ingest-endpoint.json {port, token, pid}
//   OUT: the agent's MCP `reply` tool -- the SAME channel MCP servers from
//        MCP_CONFIG_FILE (claude .mcp.json shape) are handed to dsh's
//        config-level MCP client, so replies flow to channels untouched.
// What changes: instead of `claude -p --input-format stream-json`, we spawn
// a pinned `dsh web --port 0` engine and drive ONE persistent session over
// its gateway (dsh-client.cjs).
//
// Env contract (superset-compatible with headless-lane):
//   MEM                 agent data home = dsh workspace cwd (required)
//   MCP_CONFIG_FILE     claude-format mcpServers JSON (optional)
//   SYSTEM_PROMPT_FILE  persona prose -> dsh persona row (optional)
//   DSH_MODEL           default "glm-5.2:cloud"; DSH_PROVIDER "ollama"
//   DSH_EFFORT          off|low|high|max (default max)
//   OLLAMA_BASE_URL     default http://localhost:11434/v1
//   SCHZ_DSH_BIN        override path to dsh bin.js (default: resolve)
//
// Deliberately NOT ported from headless-lane (first cut): 3-strike
// contamination breaker, mute-gate bookkeeping, model preflight. The
// crash-recovery pending FIFO IS ported (same file, same semantics:
// persist before accept, clear on turn end).

import { prependMemoryContext } from './memory/turn-context.mjs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { DshClient, promptAndCollect } = require('./dsh-client.cjs')
// The model catalog is the app's ONE list of ids and their context windows
// (0.3 P4). The lane reads the same file the Engine page's picker loads, so a
// window declared to the engine here and a window shown to the user there are
// the same number by construction rather than by two people remembering.
const MODEL_CATALOG = require('./onboarding/public/js/model-catalog.cjs')

const MEM = process.env.MEM
const MCP_CONFIG_FILE = process.env.MCP_CONFIG_FILE || ''
const SYSTEM_PROMPT_FILE = process.env.SYSTEM_PROMPT_FILE || ''

// ── route contract v2 (0.2.2 full harness swap, the owner 08-19 "클로드코드
// 아예 의존성째로 날려버려") ────────────────────────────────────────────
// Every app provider is now a dsh LLM route; provider-env.cjs's rows emit
// this env instead of Claude-CLI plumbing:
//   DSH_ROUTE          'anthropic-catalog' | 'declared'
//   DSH_PROVIDER       route id in the patch (anthropic | codex | ...)
//   DSH_ROUTE_API      declared only: anthropic-messages | openai-completions
//   DSH_ROUTE_BASE_URL declared only
//   DSH_ROUTE_KEY_ENV  name of the env var carrying the secret (the row
//                      sets that var too; catalog anthropic reads
//                      ANTHROPIC_API_KEY -- an sk-ant-oat value there flips
//                      pi-ai into native OAuth mode: Bearer + oauth beta
//                      headers + Claude Code identity block, measured 200)
//   DSH_MODEL / DSH_EFFORT
//   DSH_MODEL_VISION   '1' -> the MAIN model sees images: declared rows get
//                      input:[text,image] and markers attach inline
//   DSH_VISION_SIDECAR sidecar caption model id (local-ollama route only)
//   DSH_MODEL_CONTEXT / DSH_MODEL_MAXTOK  declared model row numbers.
//                      DSH_MODEL_CONTEXT is now an OVERRIDE only: unset, the
//                      window comes from the shared model catalog per model
//                      id (see declaredContextFor below).
// Defaults reproduce the 0.2.1 local-ollama lane so a bare `MEM=... node
// dsh-lane.mjs` still boots the glm/qwen testbed.
const DSH_ROUTE = process.env.DSH_ROUTE || 'declared'
const DSH_PROVIDER = process.env.DSH_PROVIDER || 'ollama'
const DSH_ROUTE_API = process.env.DSH_ROUTE_API || 'openai-completions'
const DSH_ROUTE_BASE_URL = process.env.DSH_ROUTE_BASE_URL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1'
const DSH_ROUTE_KEY_ENV = process.env.DSH_ROUTE_KEY_ENV || 'OLLAMA_API_KEY'
const DSH_MODEL = process.env.DSH_MODEL || 'glm-5.2:cloud'
const DSH_EFFORT = process.env.DSH_EFFORT || 'max'
const DSH_MODEL_VISION = process.env.DSH_MODEL_VISION === '1'
// Declared window, in precedence order: an explicit DSH_MODEL_CONTEXT wins
// (hand-tuned lane), then the catalog's number for THIS model, then the
// catalog's floor -- which is the 131072 this line carried as a blanket
// constant until 0.3 P4. Per-model matters: the codex route is a `declared`
// route too, so every ChatGPT lane was telling the engine its gpt-5.x model
// held 131072 tokens while codex-as-api 0.6.5 advertises 272000 and the app's
// own gauge divided by 272000. The engine compacted against a window less
// than half the real one, and nothing anywhere disagreed out loud.
const declaredContextFor = (id) => Number(process.env.DSH_MODEL_CONTEXT) > 0
  ? Number(process.env.DSH_MODEL_CONTEXT)
  : MODEL_CATALOG.dshContextWindowFor(id)
const DSH_MODEL_MAXTOK = Number(process.env.DSH_MODEL_MAXTOK) > 0 ? Number(process.env.DSH_MODEL_MAXTOK) : 16384
// 같이보기/vision: three lanes, decided by the route --
//   inline  (DSH_MODEL_VISION)   the main model sees the image part itself
//   sidecar (DSH_VISION_SIDECAR) a one-shot session on the sidecar model
//           captions it (NOT per-turn selectModel: dsh refuses a text-only
//           model on an image-bearing session -- measured 2026-08-19)
//   none                          honest cannot-see marker rewrite
const DSH_VISION_SIDECAR = process.env.DSH_VISION_SIDECAR
  || (DSH_PROVIDER === 'ollama' && !DSH_MODEL_VISION ? 'qwen3.5:cloud' : '')

const log = (m) => process.stdout.write(`[dsh-lane] ${m}\n`)
const errLog = (m) => process.stderr.write(`[dsh-lane] ${m}\n`)

// ── the <channel> tag (ported verbatim from headless-lane.mjs:304-332) ──────
// The injected-message contract every channel backend and the agent's own
// reply discipline are built around: sender/channelId ride as attributes,
// and the body is entity-escaped so content can never forge a second
// envelope. Raw content without this tag reads to the model as plain prose
// with no reply-owed framing (live catch 2026-08-19: glm answered in text
// and never called the reply tool until the tag was restored).
const escapeAttr = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeText = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
function renderChannelTag ({ content, meta = {} }) {
  const attrs = [
    `source="${escapeAttr(meta.source || 'agent-channel')}"`,
    `sender="${escapeAttr(meta.sender || 'user')}"`,
    `channelId="${escapeAttr(meta.channelId || 'in-app')}"`,
    `authorId="${escapeAttr(meta.authorId || '')}"`,
    `timestamp="${escapeAttr(meta.timestamp || '')}"`,
  ]
  if (meta.messageTs) attrs.push(`messageTs="${escapeAttr(meta.messageTs)}"`)
  if (meta.threadTs) attrs.push(`threadTs="${escapeAttr(meta.threadTs)}"`)
  return `<channel ${attrs.join(' ')}>${escapeText(content)}</channel>`
}

if (!MEM) { errLog('MEM is required'); process.exit(2) }

const endpointFile = () => path.join(MEM, '.ingest-endpoint.json')
const pendingFile = () => path.join(MEM, '.pending-inbound.json')
const heartbeatFile = () => path.join(MEM, '.lane-heartbeat.json')
const dshHome = () => path.join(MEM, '.dsh-lane-home')

// ── watchdog seam (design-0023 P3 #7) ──────────────────────────────────────
// The supervisor's stall watchdog reads the CLAUDE CLI's transcript jsonl.
// This lane does not write one -- it talks to dsh over a mux event stream --
// so on the DEFAULT lane the watchdog has been watching an empty directory
// since 0.2.2: `no this-era transcript yet ... stall lane idle until one
// appears`, once, and then silence forever. A stall detector that is silently
// inert on the default path is worse than none, because the log says it is on.
//
// This file is the evidence the supervisor can actually read. It stays on the
// SUPERVISOR side to judge and kill, deliberately: the restart ladder, the
// bounce budget (3 kills / 6h, shared across respawns) and the pidfile all
// live there, and a lane cannot enforce a budget across its own restarts or
// restart itself once it is the thing that is wedged.
//   bornTs        -- era guard. A heartbeat from a previous incarnation must
//                    never bounce a fresh child (same rule as the transcript
//                    lane's birthtime filter).
//   ts            -- last beat. Stale = this lane could not run a 15s timer.
//   lastEventTs   -- last mux event from the engine.
//   pendingSince  -- oldest un-answered inbound, or null when idle. An idle
//                    agent is NOT a stalled one; without this the watchdog
//                    would bounce an agent whose only sin was that nobody
//                    talked to it.
const LANE_BORN_TS = Date.now()
const HEARTBEAT_MS = 15_000
let lastEventTs = LANE_BORN_TS
function writeHeartbeat () {
  let pendingSince = null
  try {
    const pending = readPending()
    for (const p of pending) {
      const ts = Number(p && p.ts) || 0
      if (ts && (pendingSince === null || ts < pendingSince)) pendingSince = ts
    }
  } catch { /* unreadable pending file: report liveness anyway */ }
  // Clamp to this lane's birth. Boot REDELIVERS the previous incarnation's
  // unfinished rows, whose ts is from before this process existed -- unclamped
  // they read as "unanswered for hours" and the watchdog would bounce a lane
  // that has been alive for one second.
  if (pendingSince !== null && pendingSince < LANE_BORN_TS) pendingSince = LANE_BORN_TS
  try {
    writeJsonAtomic(heartbeatFile(), {
      lane: 'dsh', pid: process.pid, bornTs: LANE_BORN_TS, ts: Date.now(), lastEventTs, pendingSince,
    })
  } catch { /* fail-open: an unwritable heartbeat is not worth dying over */ }
}

function writeJsonAtomic (file, obj, mode) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now().toString(36)}`
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: mode || 0o600 })
  fs.renameSync(tmp, file)
}
function readPending () {
  try { return JSON.parse(fs.readFileSync(pendingFile(), 'utf8')) } catch { return [] }
}
function writePending (list) {
  try { writeJsonAtomic(pendingFile(), list); return true } catch { return false }
}

// ── patch assembly ──────────────────────────────────────────────────────────
function yamlQuote (s) {
  return JSON.stringify(String(s)) // JSON string is valid YAML scalar
}

function mcpRowsFromClaudeConfig (file) {
  if (!file || !fs.existsSync(file)) return ''
  let cfg
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    errLog(`MCP_CONFIG_FILE unreadable (${e.message}) -- continuing without MCP`)
    return ''
  }
  const servers = cfg && cfg.mcpServers ? cfg.mcpServers : {}
  // NEW rows must ride the `insert` patch verb — a bare {id,name,config}
  // entry is treated as an id-targeted override and warns "entry not found"
  // (cordis-plugin-include lib/index.js:68-93, measured 2026-08-19).
  const rows = []
  for (const [name, s] of Object.entries(servers)) {
    if (!s || typeof s !== 'object') continue
    const safe = String(name).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
    if (s.url) {
      rows.push([
        `    - id: mcp-${safe}`,
        `      name: '@deepseek-ai/dsh-mcp-client'`,
        `      config:`,
        `        serverName: ${safe}`,
        `        transport: streamable-http`,
        `        url: ${yamlQuote(s.url)}`
      ].join('\n'))
    } else if (s.command) {
      const lines = [
        `    - id: mcp-${safe}`,
        `      name: '@deepseek-ai/dsh-mcp-client'`,
        `      config:`,
        `        serverName: ${safe}`,
        `        transport: stdio`,
        `        command: ${yamlQuote(s.command)}`
      ]
      if (Array.isArray(s.args) && s.args.length) {
        lines.push(`        args: [${s.args.map(yamlQuote).join(', ')}]`)
      }
      // CHANNEL-SECRET SEAM (2026-08-21, the owner field case: discord setup on
      // the dsh lane died in a "DISCORD_BOT_TOKEN not set" FATAL loop). The
      // claude lanes forward the full parent env to MCP children, so
      // main.cjs's spawn-time token injection just arrived. The dsh harness
      // does NOT: dsh-mcp-client spawns stdio servers with
      // scrubbedParentEnv() -- /KEY|PASSWORD|SECRET|TOKEN/i names dropped
      // (dsh-subprocess) -- so every channel token vanished at this seam.
      // The harness DOES merge the row's declared env on top of the scrub,
      // and the loader yaml dialect supports `!!js` expression nodes
      // evaluated in the ENGINE process (cordis-plugin-include JsExpr +
      // cordis-plugin-loader interpolate). So: emit an expression REFERENCE,
      // never the value -- the patch file on disk carries the string
      // "process.env.DISCORD_BOT_TOKEN", not the token, honoring main.cjs's
      // BOT-TOKEN SEAM (no secret in any on-disk file). Only rows land for
      // names present in this process's env, and only THIS server's child
      // sees them -- bash/pwsh tool children stay fully scrubbed. Do NOT
      // "fix" this by renaming tokens to scrub-surviving names: that leaks
      // them into every agent subprocess.
      const passthrough = ['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']
        .filter((k) => process.env[k])
      const declared = s.env && typeof s.env === 'object' ? Object.entries(s.env) : []
      if (declared.length || passthrough.length) {
        lines.push('        env:')
        for (const [k, v] of declared) lines.push(`          ${k}: ${yamlQuote(v)}`)
        for (const k of passthrough) {
          if (!declared.some(([dk]) => dk === k)) lines.push(`          ${k}: !!js process.env.${k}`)
        }
      }
      lines.push(`        reconnect:`, `          enabled: true`)
      rows.push(lines.join('\n'))
    }
  }
  if (!rows.length) return ''
  return `- insert:\n${rows.join('\n')}`
}

function personaRow () {
  if (!SYSTEM_PROMPT_FILE || !fs.existsSync(SYSTEM_PROMPT_FILE)) return ''
  let text
  try { text = fs.readFileSync(SYSTEM_PROMPT_FILE, 'utf8') } catch { return '' }
  // Block scalar keeps the prose verbatim; indent every line by 6.
  const indented = text.split('\n').map((l) => `      ${l}`).join('\n')
  return `- id: persona\n  config:\n    text: |\n${indented}`
}

function buildPatch () {
  // The ladder the lane DECLARES to the engine. It is deliberately not the
  // same list as the picker's (model-catalog.cjs EFFORT_LEVELS): 'off' is
  // declared here and offered nowhere, 'medium' is offered by the picker and
  // declared nowhere. Both lists now live in the catalog file so the gap is
  // readable in one place; closing it is a live-engine decision, not a
  // refactor's.
  const efforts = MODEL_CATALOG.DSH_REASONING_EFFORTS
    .map((e) => e === 'off' ? '              off:' : `              ${e}: ${e}`).join('\n')
  // Per-model window, so the vision sidecar declares its OWN number instead
  // of inheriting the main model's -- they are different models.
  const modelRow = (id, name, vision) => [
    `          - id: ${yamlQuote(id)}`,
    `            name: ${yamlQuote(name)}`,
    `            input: [${vision ? 'text, image' : 'text'}]`,
    `            contextWindow: ${declaredContextFor(id)}`,
    `            maxTokens: ${DSH_MODEL_MAXTOK}`,
    `            reasoningEfforts:`,
    efforts
  ].join('\n')
  // Retry policy: dsh's default retryableCodes INCLUDE EMPTY_RESPONSE, but a
  // channel agent's final assistant message after its reply tool call is
  // NORMALLY empty -- the reply already went out through the tool. With the
  // default policy every silent turn end burned maxRetries (2) extra
  // full-context completions re-asking the model to say nothing (measured on
  // the 0.2.3 mac E2E: turns 2 and 3 each surfaced EMPTY_RESPONSE after the
  // reply had already been delivered). Same list as the default minus
  // EMPTY_RESPONSE; genuine transients (RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT)
  // keep their retries.
  const retryPolicyBlock = [
    '        retryPolicy:',
    '          mode: normal',
    '          retryableCodes: [RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]'
  ]
  let providerBlock
  if (DSH_ROUTE === 'anthropic-catalog') {
    // Catalog route: pi-ai ships the full anthropic model list (ids,
    // context windows, vision modality, anthropic-messages protocol). Only
    // the credential env is ours. An sk-ant-oat value in that env flips
    // pi-ai's native OAuth mode -- see the route contract comment above.
    providerBlock = [
      '      anthropic:',
      `        apiKeyEnv: ${DSH_ROUTE_KEY_ENV}`,
      ...retryPolicyBlock
    ].join('\n')
  } else {
    // Hand-declared route: everything explicit. The main model row plus,
    // when a caption sidecar is configured, the sidecar's vision row.
    const rows = [modelRow(DSH_MODEL, DSH_MODEL, DSH_MODEL_VISION)]
    if (DSH_VISION_SIDECAR && DSH_VISION_SIDECAR !== DSH_MODEL) {
      rows.push(modelRow(DSH_VISION_SIDECAR, `${DSH_VISION_SIDECAR} (vision sidecar)`, true))
    }
    providerBlock = [
      `      ${DSH_PROVIDER}:`,
      `        displayName: ${yamlQuote(DSH_PROVIDER)}`,
      `        apiKeyEnv: ${DSH_ROUTE_KEY_ENV}`,
      `        api: ${DSH_ROUTE_API}`,
      `        baseURL: ${yamlQuote(DSH_ROUTE_BASE_URL)}`,
      ...retryPolicyBlock,
      '        models:',
      ...rows
    ].join('\n')
  }
  const base = `- id: agent-default-model
  config:
    provider: ${DSH_ROUTE === 'anthropic-catalog' ? 'anthropic' : DSH_PROVIDER}
    model: ${yamlQuote(DSH_MODEL)}
- id: hmr
  disabled: true
- id: tool-ask-user
  # ask_user_question resolves through the dsh WEB UI's question provider,
  # which no Scheherazade user ever opens -- the tool call awaits an answer
  # forever and the turn hangs (measured: the owner's box 2026-08-19 17:55, turn
  # never completed after ask_user_question). A channel-mediated agent asks
  # questions through the reply tool instead.
  disabled: true
- id: skill-filesystem
  # 0.2.4 instruction-surface port: skills seeded to MEM/.claude/skills
  # were a Claude-Code-only surface (CC loads .claude/skills natively; dsh
  # does not). dsh's own filesystem skill provider parses the SAME
  # <name>/SKILL.md frontmatter (name/description), so this HOST-level
  # provider points at the seeded dir unchanged and the hash-refresh
  # seeding machinery keeps working. The agent preset's own tool-skill
  # merges "whatever the deployment registered globally" into its catalog,
  # so this is the only row the port needs -- the preset already mounts
  # agent-instructions (CLAUDE.md loads from cwd) and tool-skill (catalog +
  # loader). providerName is unique per README guidance for isolated
  # custom-root providers; includeDefaultRoots off: only the app-owned dir,
  # never the user's ~/.dsh or ~/.agents skills.
  disabled: false
  config:
    providerName: app-seeded
    includeDefaultRoots: false
    customSkillDirs:
      - ${yamlQuote(path.join(MEM, '.claude', 'skills'))}
- id: agent-presets
  # 0.2.4 websearch recovery: the model-facing web_search tool is mounted
  # by the agent PRESET (standard/agent.cordis.yml), not the profile -- the
  # profile-level tool-web row is disabled yet the E2E request header still
  # carried web_search (measured 2026-08-20; the owner's 0.2.3 "DeepSeek API
  # key" answer was REAL, not confabulated). Preset rows cannot be patched
  # and the launcher force-overwrites config.roots with the shipped root,
  # so the lane authors its OWN preset id into the always-scanned user root
  # (<dshHome>/.agent-presets) -- shipped standard minus the tool-web row
  # (ensureLanePreset below) -- and points the default here. Search is the
  # chromux websearch skill's job: keyless, works on every backend.
  config:
    default: ${LANE_PRESET_ID}
- id: web
  # With no tool-web row anywhere, the web service + its DeepSeek search
  # provider are dead weight; pinning them off keeps any future surface
  # from resurrecting a keyed search path.
  disabled: true
- id: web-search-deepseek
  disabled: true
- id: llm-pi-ai
  config:
    providers:
${providerBlock}
`
  const parts = [base]
  const persona = personaRow()
  if (persona) parts.push(persona)
  const mcp = mcpRowsFromClaudeConfig(MCP_CONFIG_FILE)
  if (mcp) parts.push(mcp)
  const patch = parts.join('\n')
  fs.mkdirSync(dshHome(), { recursive: true })
  ensureLanePreset() // the patch's agent-presets default row names this preset
  const p = path.join(dshHome(), 'lane.patch.yml')
  fs.writeFileSync(p, patch)
  return p
}

function dshBin () {
  if (process.env.SCHZ_DSH_BIN) return process.env.SCHZ_DSH_BIN
  const p = require.resolve('@deepseek-ai/dsh/lib/bin.js')
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

// ── lane-owned agent preset (0.2.4) ─────────────────────────────────────────
// Shipped `standard` minus its tool-web row, authored into the user preset
// root the roster always scans. Re-derived from the shipped file at every
// boot so a dsh upgrade's preset changes flow through; only OUR delta (no
// web_search tool) is pinned. See the agent-presets patch row for why this
// is the only override path that exists.
const LANE_PRESET_ID = 'schz-standard'
function ensureLanePreset () {
  const shippedDir = path.join(path.dirname(dshBin()), '..', 'config', 'agent-presets', 'standard')
  const src = fs.readFileSync(path.join(shippedDir, 'agent.cordis.yml'), 'utf8')
  const cut = src.indexOf('- id: tool-web')
  let filtered = (cut === -1 ? src : src.slice(0, cut)) +
    '# (tool-web row removed by dsh-lane 0.2.4: web search is the chromux\n' +
    '# websearch skill -- keyless, backend-independent. Locked 08-20.)\n'
  // tool-ask-user: PRESET-mounted, so the profile-level `tool-ask-user
  // disabled: true` patch row (added after the 08-19 hang) never reached the
  // session -- the exact "preset rows cannot be patched" class the tool-web
  // comment above documents. Confirmed live 2026-08-27 16:58: dsh-lane logged
  // `tool> ask_user_question` and the turn hung sera (no web UI ever answers).
  // Remove the row from the authored preset like tool-web; shipped standard
  // has it BEFORE tool-web (L237 vs L247) so the cut above never caught it.
  filtered = filtered.replace(
    /^- id: tool-ask-user\n(?:^ {2}.*\n|^\n)*?(?=^- id: |\Z)/m,
    '# (tool-ask-user row removed by dsh-lane 0.2.17: ask_user_question awaits\n' +
    '# a web-UI answer no Scheherazade user can give -- turn hangs forever.\n' +
    '# Channel agents ask through the reply tool. 08-27 16:58 hang.)\n'
  )
  filtered = guardSubagentRows(filtered, subagentAgentOptions())
  const destDir = path.join(dshHome(), '.agent-presets', LANE_PRESET_ID)
  fs.mkdirSync(destDir, { recursive: true })
  fs.writeFileSync(path.join(destDir, 'agent.cordis.yml'), filtered)
  fs.writeFileSync(path.join(destDir, 'preset.yml'),
    'name: Scheherazade standard\ndescription: shipped standard minus web_search (chromux skill carries search)\norder: 1\n')
}

// Subagent containment (2026-08-20, the owner cto field test: "서브에이전트 메세지가
// 계속 인앱챗으로 역류함"). A delegated child joins the SAME preset as its
// parent (session header agentPreset: schz-standard, measured), so it inherits
// the full channel surface: the agent-channel MCP reply/react tools AND the
// persona that instructs "answer through the reply tool". A dutiful child
// therefore messages the USER directly -- its report belongs to the parent,
// not the chat. Two-part fix, applied to the authored preset text:
//   1. tool-subagent rows (subagent, subagent_fork): add `toolFilter.deny`
//      for the channel tools + a worker `persona` override. Both flow into
//      the delegation request (dsh-tool-subagent lib line ~229-230) and the
//      spawn provider honors them (capabilities toolFilter: true).
//   2. tool-ralph and tool-workflow: DISABLED. Their configs have no
//      toolFilter, so their children cannot be contained -- a channel agent
//      does not need loop/workflow orchestration badly enough to keep an
//      uncontainable leak path open.
const SUBAGENT_DENY = 'deny: [mcp__agent-channel__reply, mcp__agent-channel__react]'
const SUBAGENT_PERSONA =
  'You are a background subagent doing one delegated task for the main agent. ' +
  'You are not the user-facing agent: never message the user, never use ' +
  'channel/chat tools. Deliver everything you found as your final assistant ' +
  'message -- that text IS your report to the parent agent.'
// Subagent model pin (0.2.19, Sera field report 2026-09-02: subagents ran the
// parent's opus-tier model; directive = run them on haiku/sonnet tier). The
// pin must live HERE, not in lane.patch.yml or a hand edit: tool-subagent's
// agentOptions is PRESET-mounted config, and ensureLanePreset force-rewrites
// the authored preset every boot -- the same "preset rows cannot be patched"
// class as tool-web/tool-ask-user above (Sera measured the overwrite live).
// Route-aware defaults: anthropic-catalog pins claude-sonnet-5-5 (current
// subagent-tier id, verified against the API skill 2026-09-29, Mino 09-29 14:26 5.0 -> 5.5; NEVER append
// a date suffix); a declared route keeps the parent model (explicit, same
// behavior as before) because we cannot guess a valid id on an arbitrary
// endpoint -- a wrong id kills every spawn. DSH_SUBAGENT_MODEL overrides both.
function subagentAgentOptions () {
  const provider = DSH_ROUTE === 'anthropic-catalog' ? 'anthropic' : DSH_PROVIDER
  const model = process.env.DSH_SUBAGENT_MODEL ||
    (DSH_ROUTE === 'anthropic-catalog' ? 'claude-sonnet-5-5' : DSH_MODEL)
  return { provider, model }
}
function guardSubagentRows (yamlText, agentOptions = null) {
  // Idempotent: ensureLanePreset always feeds the pristine shipped yaml, but
  // a future caller re-running on authored output must not stack the rows.
  if (yamlText.includes(SUBAGENT_DENY)) return yamlText
  const lines = yamlText.split('\n')
  const out = []
  let disableRow = null
  for (const line of lines) {
    out.push(line)
    // 1. containment config right after each continuable subagent row's tail
    //    line (only the two ACTIVE rows carry `backgroundMode: continuable`;
    //    codex/claude-code variants are one-shot + disabled).
    const m = line.match(/^(\s+)backgroundMode: continuable$/)
    if (m) {
      const ind = m[1]
      out.push(`${ind}toolFilter:`)
      out.push(`${ind}  ${SUBAGENT_DENY}`)
      out.push(`${ind}persona: >-`)
      out.push(`${ind}  ${SUBAGENT_PERSONA}`)
      // agentOptions schema per dsh-tool-subagent lib Config: { provider,
      // model, maxTokens } -- provider+model only; maxTokens stays default.
      if (agentOptions) {
        out.push(`${ind}agentOptions:`)
        out.push(`${ind}  provider: ${agentOptions.provider}`)
        out.push(`${ind}  model: ${agentOptions.model}`)
      }
    }
    // 2. disable the uncontainable spawn paths: mark at the row id, emit
    //    `disabled: true` right after the row's `name:` line.
    const row = line.match(/^(\s+)- id: (tool-ralph|tool-workflow)$/)
    if (row) { disableRow = row[1]; continue }
    if (disableRow !== null && /^\s+name: /.test(line)) {
      out.push(`${disableRow}  disabled: true # dsh-lane: children inherit the channel surface unfiltered`)
      disableRow = null
    }
  }
  return out.join('\n')
}

// ── engine boot ─────────────────────────────────────────────────────────────
let child = null
let childExited = false
// Every lane-initiated engine kill goes here (0.3.6). win32: a plain kill is
// TerminateProcess on one pid and orphans the engine's MCP servers, so use
// proc.killTree (taskkill /T /F); posix keeps SIGTERM. Exported-shape helper
// takes its seams as arguments so a test can drive it without a real kill.
export function killEngine (c, { platform = process.platform, killTree = (pid, sig) => require('./proc.cjs').killTree(pid, sig) } = {}) {
  if (!c || c.killed) return 'gone'
  if (platform === 'win32') {
    try { killTree(c.pid, 'SIGKILL'); return 'tree' } catch {
      try { c.kill('SIGKILL') } catch {}
      return 'single'
    }
  }
  try { c.kill('SIGTERM') } catch {}
  return 'signal'
}

// Turn-error recycle (0.2.19, Sera field report 2026-09-02): the supervisor's
// stall watchdog reads claude-CLI transcripts under ~/.claude/projects, which
// a dsh lane never creates -- so its stall lane idles forever on this route
// ("no this-era transcript yet", every boot since 08-24). Sera sat 2h in a
// `turn end (error: CONTEXT_WINDOW_EXCEEDED)` loop: the process is alive, so
// no supervisor restart; every inbound burns a turn into the same wall. The
// lane detects its own terminal shape instead: N CONSECUTIVE genuine turn-end
// errors -> kill engine + exit(1), supervisor respawns, and main() mints a
// FRESH session (createSession every boot) -- exactly what the manual
// control-panel bounce did to revive her. EMPTY_RESPONSE is excluded (healthy
// silent finish, see the turn-end label logic); any clean turn resets the
// count. 0 disables.
const TURN_ERROR_RECYCLE = Number(process.env.DSH_TURN_ERROR_RECYCLE ?? 3)
let consecutiveTurnErrors = 0

function spawnEngine (patchPath) {
  const env = {
    ...process.env,
    DSH_HOME: dshHome(),
    // The route's key env must resolve to SOMETHING or pi-ai refuses the
    // route (PI_AI_ERROR, measured); keyless local proxies get a dummy.
    [DSH_ROUTE_KEY_ENV]: process.env[DSH_ROUTE_KEY_ENV] || 'local-dummy',
    DSH_TELEMETRY_MODE: process.env.DSH_TELEMETRY_MODE || 'DISABLED',
    // Product contract port (run.sh --dangerously-skip-permissions, the owner
    // 2026-07-04 "bypass까지만 바로 되도록"): full agent autonomy inside its
    // own DATA_HOME, no permission popups. dsh's approval plugin policy is
    // 'ask' under the default workspace-write mode, and the ask resolves
    // through the dsh WEB UI no Scheherazade user ever opens -- a bash call
    // that escalates (e.g. chromux driving Chrome) hangs the turn forever
    // (live catch 2026-08-20 12:0x: websearch E2E stuck 25 min on
    // approval/asked). danger-full-access flips the policy to 'never'.
    DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'danger-full-access'
  }
  const isElectronNode = !!process.versions.electron
  const args = [...(isElectronNode ? ['--expose-internals'] : []), dshBin(), 'web', '--patch', patchPath, '--port', '0']
  child = spawn(process.execPath, args, { cwd: MEM, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.on('exit', (code) => {
    childExited = true
    errLog(`dsh engine exited ${code}`)
    // Supervisor owns restarts (same posture as headless-lane): exit so the
    // wrapper's restart loop sees a dead lane instead of a zombie half.
    process.exit(code === 0 ? 0 : 1)
  })
  return new Promise((resolve, reject) => {
    let settled = false
    const onLine = (buf) => {
      const s = buf.toString()
      const m = s.match(/dsh web:\s*(http:\/\/[\d.]+:\d+)/)
      if (m && !settled) { settled = true; resolve(m[1]) }
      const t = s.trim()
      if (t && !/^\s*$/.test(t)) log(`engine: ${t.slice(0, 200)}`)
    }
    child.stdout.on('data', onLine)
    child.stderr.on('data', onLine)
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('dsh web did not announce a URL in 45s')) } }, 45000)
  })
}

// ── main ────────────────────────────────────────────────────────────────────
async function main () {
  const patch = buildPatch()
  const url = await spawnEngine(patch)
  log(`engine up at ${url}`)
  const client = new DshClient(url)

  const created = await client.createSession({ cwd: MEM })
  const sessionId = created.sessionId || created.id
  log(`session ${sessionId} (cwd=${MEM}, model=${DSH_PROVIDER}/${DSH_MODEL})`)
  try { await client.selectModel(sessionId, DSH_PROVIDER, DSH_MODEL, DSH_EFFORT === 'off' ? undefined : DSH_EFFORT) } catch (e) {
    log(`selectModel skipped: ${e.message.slice(0, 120)}`)
  }

  // Skill-catalog nudge (0.2.4, measured 2026-08-20): the session is created
  // above BEFORE skill-filesystem finishes its first discovery, and
  // tool-skill only injects the initial <available_skills> catalog when
  // discovery beats the first request -- lose that boot race and the catalog
  // NEVER appears (the model can load skills by exact name but cannot see
  // what exists; E2E turn 1 confirmed). A later mtime change appends a
  // replacement catalog through the watcher, so: touch one seeded SKILL.md
  // shortly after session creation. Idempotent -- if the catalog already
  // rendered, the replacement it triggers carries the same content.
  setTimeout(() => {
    try {
      const skillsRoot = path.join(MEM, '.claude', 'skills')
      for (const d of fs.readdirSync(skillsRoot)) {
        const f = path.join(skillsRoot, d, 'SKILL.md')
        if (fs.existsSync(f)) {
          const now = new Date()
          fs.utimesSync(f, now, now)
          log(`skill catalog nudge (${d})`)
          break
        }
      }
    } catch { /* no skills seeded -- nothing to nudge */ }
  }, 2500)

  // File ledger (같이보기 batch parity): under Claude Code this was a
  // PostToolUse hook; dsh has no shell hooks, so the lane sources the SAME
  // JSONL (DATA_HOME/.gates/file-ledger.jsonl, rows {ts,tool,path,failed?})
  // from tool/call + tool/result events. GET /api/files/recent reads it
  // unchanged. dsh file-writing tools: write / edit / str_replace_editor.
  const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
  const LEDGER_DIR = path.join(MEM, '.gates')
  const LEDGER_PATH = path.join(LEDGER_DIR, 'file-ledger.jsonl')
  const MAX_LEDGER_BYTES = 512 * 1024
  const pendingToolPaths = new Map() // callId -> {tool, path}
  function ledgerAppend (row) {
    try {
      fs.mkdirSync(LEDGER_DIR, { recursive: true })
      try {
        if (fs.statSync(LEDGER_PATH).size > MAX_LEDGER_BYTES) fs.renameSync(LEDGER_PATH, `${LEDGER_PATH}.1`)
      } catch {}
      fs.appendFileSync(LEDGER_PATH, JSON.stringify(row) + '\n', 'utf8')
    } catch { /* fail-open, same contract as the hook it replaces */ }
  }

  // ── local-chat presence feed (activity + think, 0.2.1) ────────────────────
  // Under Claude Code the activity feed came from the PreToolUse hook
  // (hooks/pre-tool-activity.mjs); dsh has no shell hooks, so the lane posts
  // the same POST /activity itself from mux events -- and adds kind:'think'
  // (reasoning-delta chunks, flushed paragraph-sized) for the chat page's
  // collapsible Think fold. Same posture as the hook it replaces: bearer
  // token from MEM/local-channel.json read per post (port changes per
  // channel restart), 800ms cap, fail-open -- presence must never wedge the
  // lane. Local backend only, by the same design: the port file only exists
  // while channel-local's surface runs.
  function postPresence (label, kind, extra) {
    let ep
    try {
      ep = JSON.parse(fs.readFileSync(path.join(MEM, 'local-channel.json'), 'utf8'))
    } catch { return }
    const port = Number(ep && ep.port)
    const token = String((ep && ep.token) || '')
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return
    // kind 'memory-read' (2026-09-28, the memory mark) is the one post here
    // that is NOT presence: it goes to /memory-read, carries no body, and
    // renders nothing -- it arms the flag channel-local hands to the next
    // reply (the same signal hooks/pre-tool-activity.mjs sends on the claude
    // lane, so both lanes mark the same way). Every other kind is a status
    // line for the page.
    const memoryRead = kind === 'memory-read'
    fetch(`http://127.0.0.1:${port}/${memoryRead ? 'memory-read' : 'activity'}`, {
      method: 'POST',
      headers: memoryRead
        ? { authorization: `Bearer ${token}` }
        : { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: memoryRead ? undefined : JSON.stringify(kind ? { label, kind, ...(extra || {}) } : { label }),
      signal: AbortSignal.timeout(800)
    }).catch(() => {})
  }
  // Activity labels mirror pre-tool-activity.mjs's per-tool convention:
  // bash rides its bare command/description, the rest get a short prefix.
  const truncLabel = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
  // The memory READ tools, by the harness's MCP name (server key `memory` in
  // .mcp.json; names from memory/server.mjs's TOOLS). Kept in step with the
  // same list in hooks/pre-tool-activity.mjs -- the lane cannot import from
  // that file (it is a hook script, not a module), so the two live copies are
  // pinned against each other by tests/test-dsh-lane-stream.mjs.
  const MEMORY_READ_TOOLS = new Set([
    'mcp__memory__memory_query',
    'mcp__memory__journal_read',
    'mcp__memory__memory_recall_material'
  ])
  function activityLabelFor (name, args) {
    const a = args || {}
    if (name === 'bash' || name === 'shell') return truncLabel(a.description || a.command || a.cmd)
    if (name === 'fetch' || name === 'web_fetch') return a.url ? `WebFetch: ${truncLabel(a.url)}` : ''
    if (name === 'web_search') return a.query ? `WebSearch: ${truncLabel(a.query)}` : ''
    if (FILE_TOOLS.has(name)) return `${name}: ${truncLabel(a.file_path || a.path || a.notebook_path)}`
    if (name === 'run_code' || name === 'code') return `run_code: ${truncLabel(a.description || (typeof a.code === 'string' ? a.code : ''))}`
    if (String(name || '').startsWith('mcp__')) return '' // channel plumbing (reply etc.) is not user-facing work
    return name ? `${name}${a.description ? `: ${truncLabel(a.description)}` : ''}` : ''
  }
  // Reasoning accumulator: flush to the channel in paragraph-sized pieces
  // (per-delta posts would be one HTTP round trip per token). Flush at
  // ~700 chars or on turn end; cap a runaway turn's total so the fold
  // cannot eat the page.
  let thinkBuf = ''
  let thinkSentThisTurn = 0
  const THINK_FLUSH_AT = 700
  const THINK_TURN_CAP = 20000
  function flushThink (force) {
    const text = thinkBuf.trim()
    if (!text) return
    if (!force && text.length < THINK_FLUSH_AT) return
    thinkBuf = ''
    if (thinkSentThisTurn >= THINK_TURN_CAP) return
    thinkSentThisTurn += text.length
    postPresence(text.slice(0, 3900), 'think')
  }

  // ── answer stream (0.2.4, the owner "두두두둑 생성되는거 보이잖아, 그런거 가능?") ──
  // Visible text-deltas mirror to the local chat page as a GROWING DRAFT
  // bubble: kind:'stream' posts append server-side draft text that /out
  // returns beside the queue (never a transcript item, never persisted).
  // The reply tool's real message retires the draft (channel-local clears
  // it on enqueueOutbound); the turn-end done-post is the belt-and-braces
  // clear for a turn that composed text but never called reply (mute case).
  // Chunks are NOT trimmed -- mid-sentence whitespace is content here.
  // Gated to in-app turns: a Discord-sourced turn's reply belongs to
  // Discord, not half-mirrored into the local pane as a phantom draft.
  let lastInboundChannelId = 'in-app'
  let streamBuf = ''
  let streamSentThisTurn = 0
  let streamedThisTurn = false
  let streamTimer = null
  let turnText = '' // FULL body text of the turn, for mute-promotion (below)
  const STREAM_FLUSH_AT = 80
  const STREAM_FLUSH_MS = 150
  const STREAM_TURN_CAP = 16000
  const PROMOTE_CAP = 9000 // /activity body cap is 10KB; leave envelope room
  function flushStream (force) {
    if (lastInboundChannelId !== 'in-app') { streamBuf = ''; return }
    if (!streamBuf) return
    if (!force && streamBuf.length < STREAM_FLUSH_AT) {
      // Small tail: let it ride a short timer so slow token trickles still
      // paint without one HTTP round trip per token.
      if (!streamTimer) streamTimer = setTimeout(() => { streamTimer = null; flushStream(true) }, STREAM_FLUSH_MS)
      return
    }
    if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
    const text = streamBuf
    streamBuf = ''
    if (streamSentThisTurn >= STREAM_TURN_CAP) return
    streamSentThisTurn += text.length
    streamedThisTurn = true
    postPresence(text.slice(0, 3900), 'stream')
  }
  // A channel agent's ANSWER usually rides the reply tool's arguments, not
  // body text (live catch on the first full-stack E2E: body text-deltas
  // stayed empty while the whole answer generated inside
  // mcp__agent-channel__reply -- the draft never painted). dsh streams
  // tool-call-delta chunks with the tool NAME and argumentsDelta, so the
  // lane watches reply-class calls and incrementally extracts the `text`
  // field from the growing JSON. Escape-aware, resumable: an incomplete
  // \u or trailing backslash stops the scan until more delta arrives.
  const replyArgStreams = new Map() // callId -> { buf, sent }
  // Once reply args start streaming, they ARE the answer -- body text around
  // them is meta commentary, not the message. Live catch on the glm route
  // (2026-08-20 ② provider matrix): glm narrates plans in body text before
  // calling reply, so the draft painted "이번엔 두 문단, 주제는... 써야겠다" glued
  // to the real answer. claude's body deltas stay empty on reply turns, which
  // is why the mixed-draft never showed there. On the first extracted arg
  // text the stale preamble draft is wiped (done-post) and body text-deltas
  // stop feeding the draft for the rest of the turn (turnText still
  // accumulates them -- mute promotion wants the composed text, warts and all).
  let replyArgStarted = false
  function extractTextField (buf) {
    const k = buf.indexOf('"text"')
    if (k === -1) return null
    let i = buf.indexOf(':', k + 6)
    if (i === -1) return null
    i++
    while (i < buf.length && ' \n\r\t'.includes(buf[i])) i++
    if (buf[i] !== '"') return null
    i++
    let out = ''
    while (i < buf.length) {
      const ch = buf[i]
      if (ch === '\\') {
        const esc = buf[i + 1]
        if (esc === undefined) break // partial escape at the buffer edge
        if (esc === 'u') {
          const hex = buf.slice(i + 2, i + 6)
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) break
          out += String.fromCharCode(parseInt(hex, 16))
          i += 6
          continue
        }
        const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' }
        out += map[esc] !== undefined ? map[esc] : esc
        i += 2
        continue
      }
      if (ch === '"') break // string closed -- the text value is complete
      out += ch
      i++
    }
    return out
  }
  function onReplyArgDelta (id, delta) {
    let s = replyArgStreams.get(id)
    if (!s) { s = { buf: '', sent: 0 }; replyArgStreams.set(id, s) }
    s.buf += delta
    const text = extractTextField(s.buf)
    if (text === null || text.length <= s.sent) return
    if (!replyArgStarted) {
      replyArgStarted = true
      if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
      streamBuf = ''
      if (streamedThisTurn) { postPresence('', 'stream', { done: true }); streamedThisTurn = false }
    }
    streamBuf += text.slice(s.sent)
    s.sent = text.length
    flushStream(false)
  }

  // ── mute recovery (ported from headless-lane; live catch 0.2.2: claude
  // route answered an image turn in TEXT with no reply call -- the exact
  // failure class stop-reply-guard existed for, and dsh has no stop hook,
  // so the LANE convicts and nudges). Same decision table: reply-class
  // call -> clear; user turn composed text but sent nothing -> one nudge
  // (session cap); ledger file shared with the UI's model-revert offer.
  const isReplyClassTool = (name) => /__(?:reply|send_file_to_discord|react)$/.test(String(name || ''))
  const opensMuteGate = ({ channelId, content } = {}) => {
    if (String(channelId || '') === 'system') return false
    if (/^\s*\[reaction\]/.test(String(content || ''))) return false
    return true
  }
  const MUTE_NUDGE_SESSION_CAP = Math.max(1, Number(process.env.SCHEHERAZADE_MUTE_NUDGE_CAP) || 5)
  const strikesFile = () => path.join(MEM, '.mute-strikes.json')
  function recordMuteStrike () {
    let cur = { strikes: 0 }
    try { cur = JSON.parse(fs.readFileSync(strikesFile(), 'utf8')) } catch {}
    const next = { strikes: (Number(cur.strikes) || 0) + 1, model: DSH_MODEL, lastAt: Date.now() }
    try { writeJsonAtomic(strikesFile(), next) } catch {}
    return next.strikes
  }
  function clearMuteStrike () {
    try { fs.unlinkSync(strikesFile()) } catch {}
  }
  let turnHadUserInbound = false
  let sawReplyThisTurn = false
  let sawTextThisTurn = false
  let muteNudgeCount = 0
  // Turn-level STOP state (0.3.1, contract-parity with headless-lane's
  // /interrupt). Unlike the claude lane there is no child stdin to kill a turn
  // on: the dsh gateway exposes session.cancel, so this lane's stop is the
  // SOFT path -- no engine kill, no lane reboot, no --resume. openTurn is the
  // 409 gate: set when a prompt goes out, cleared at turn/end.
  let openTurn = false
  // Deliver a mute turn's composed text as the real chat message. Unlike
  // postPresence this is DELIVERY, not presence -- so it verifies the POST
  // landed and falls back to the nudge when it did not (channel down, port
  // stale). channel-local's promote branch enqueues the text as a normal
  // agent message and retires the draft in the same breath.
  function promoteTurnText (text) {
    const fail = (why) => {
      errLog(`mute promotion failed (${why}) -- falling back to the nudge`)
      sendMuteNudge()
    }
    let ep
    try { ep = JSON.parse(fs.readFileSync(path.join(MEM, 'local-channel.json'), 'utf8')) } catch { return fail('no local-channel.json') }
    const port = Number(ep && ep.port)
    const token = String((ep && ep.token) || '')
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !token) return fail('bad endpoint file')
    fetch(`http://127.0.0.1:${port}/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ label: text.slice(0, PROMOTE_CAP), kind: 'stream', promote: true }),
      signal: AbortSignal.timeout(3000)
    }).then((r) => { if (!r.ok) throw new Error(`status ${r.status}`) })
      .catch((e) => fail(e.message.slice(0, 80)))
  }

  function sendMuteNudge () {
    const tag = renderChannelTag({
      content: '[SYSTEM] 방금 사용자에게 보낼 답을 작성했지만 reply 도구를 호출하지 않아 실제로는 전달되지 않았다. 그 답을 새로 쓰지 말고 지금 mcp__agent-channel__reply(같은 channelId)로 그대로 전송하라. 정말로 보낼 내용이 없다고 판단했다면 그 판단을 한 줄로라도 답하라.',
      meta: { source: 'system', sender: 'system', channelId: 'system' }
    })
    client.prompt(sessionId, [{ type: 'text', text: tag }])
      .catch((e) => errLog(`mute nudge failed: ${e.message.slice(0, 120)}`))
  }

  // ── background-subagent roster (0.2.15, the owner "서브 스폰하면 서브도
  // working 정보에 띄우게") ─────────────────────────────────────────────
  // The subagent tool's result names what it launched ("started background
  // subagent job X" / "started subagent Y" -- dsh-tool-subagent's render);
  // the settlement notice comes back as a user message with
  // source.kind:'subagent-settled' and senderSessionId = the child id.
  // Roster updates ride postPresence kind:'bg' (fail-open, local page only).
  const pendingSubagentCalls = new Map() // callId -> display label
  const BG_STARTED_RE = /^started (?:background subagent job|subagent) (\S+)/
  function eventMessageText (d) {
    const content = d && d.message && d.message.content
    if (!Array.isArray(content)) return ''
    return content.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('\n')
  }

  // Turn-close accounting: clear pending entries older than the turn end.
  const mux = client.openMux({
    onEvent (sid, event) {
      // Liveness BEFORE the session filter: an event for any session still
      // proves the engine is talking and this lane is reading it.
      lastEventTs = Date.now()
      if (sid !== sessionId || !event) return
      // Settlement notice (any event type that carries the injected user
      // message): retire the child from the roster by its own id.
      try {
        const src = event.data && event.data.message && event.data.message.source
        if (src && src.kind === 'subagent-settled' && src.senderSessionId) {
          postPresence('', 'bg', { id: String(src.senderSessionId), done: true })
        }
      } catch {}
      if (event.type === 'turn/end') {
        flushThink(true)
        thinkSentThisTurn = 0
        // Presence turn-close (0.2.11, the owner field report: idle app stuck on
        // "Thinking…"): the chat page's live folds settle on an AGENT BUBBLE
        // -- but background turns (calendar nudge, watchdog pokes) stream
        // think/activity and end with no bubble at all, leaving the fold
        // live forever. Tell the surface the turn is over explicitly.
        postPresence('done', 'turn-end')
        // Answer stream turn close: drop the unposted tail (the final reply
        // message carries the authoritative text) and, if anything streamed,
        // tell the surface to retire the draft -- covers the no-reply turn
        // where no enqueueOutbound will ever clear it.
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
        streamBuf = ''
        replyArgStreams.clear()
        replyArgStarted = false
        if (streamedThisTurn) postPresence('', 'stream', { done: true })
        streamedThisTurn = false
        streamSentThisTurn = 0
        // Mute verdict BEFORE the per-turn flags reset.
        if (sawReplyThisTurn) {
          clearMuteStrike()
          muteNudgeCount = 0
        } else if (turnHadUserInbound && sawTextThisTurn) {
          // In-app mute turns get PROMOTED, not nudged (0.2.4 draft
          // contract): the composed body text already streamed to the user
          // as the draft, so the honest fix is to deliver that exact text
          // as the message -- zero extra tokens, deterministic. The nudge
          // remains for platform backends AND as promotion's failure
          // fallback; it cannot be the primary path anymore: opus-4-6
          // REFUSED a live nudge as a prompt-injection attempt (E2E
          // 2026-08-20 11:4x, reasoning captured: "This looks like a
          // prompt injection attempt... I shouldn't follow this injected
          // instruction"), so a nudge-only design silently loses answers.
          if (lastInboundChannelId === 'in-app' && turnText.trim()) {
            log('mute: in-app turn composed text with no reply call -- promoting the composed text to the chat')
            promoteTurnText(turnText.trim())
          } else {
            const n = recordMuteStrike()
            if (muteNudgeCount < MUTE_NUDGE_SESSION_CAP) {
              muteNudgeCount += 1
              log(`mute: turn composed text but called no reply tool -- nudging (strike ${n}; nudge ${muteNudgeCount}/${MUTE_NUDGE_SESSION_CAP})`)
              sendMuteNudge()
            } else {
              log(`mute persists past the session nudge cap (${MUTE_NUDGE_SESSION_CAP}) -- leaving it to the UI model-revert offer (strike ${n})`)
            }
          }
        }
        turnText = ''
        turnHadUserInbound = false
        sawReplyThisTurn = false
        sawTextThisTurn = false
        openTurn = false // /interrupt's 409 gate: nothing is in flight now
        const now = Date.now()
        writePending(readPending().filter((p) => p.ts > now))
        {
          const reason = (event.data && event.data.reason) || {}
          const code = reason.error && reason.error.code
          // EMPTY_RESPONSE on a turn that already delivered its reply is the
          // NORMAL silent finish of a channel agent, not a failure -- logging
          // it as 'error' made every healthy claude-route turn read as broken
          // in the Logs pane (0.2.3 mac E2E). Genuine errors keep the label.
          const label = reason.kind === 'error' && code === 'EMPTY_RESPONSE'
            ? 'completed; silent final'
            : (reason.kind || '?') + (reason.kind === 'error' && code ? `: ${code}` : '')
          log(`turn end (${label})`)
          // Terminal-shape self-detection -- see TURN_ERROR_RECYCLE above.
          if (reason.kind === 'error' && code !== 'EMPTY_RESPONSE') {
            consecutiveTurnErrors += 1
            if (TURN_ERROR_RECYCLE > 0 && consecutiveTurnErrors >= TURN_ERROR_RECYCLE) {
              errLog(`${consecutiveTurnErrors} consecutive turn errors (last: ${code || 'unknown'}) -- recycling lane for a fresh session`)
              killEngine(child)
              process.exit(1)
            }
          } else {
            consecutiveTurnErrors = 0
          }
        }
      } else if (event.type === 'assistant/chunk') {
        const c = event.data && event.data.chunk
        if (c && c.type === 'reasoning-delta') {
          thinkBuf += c.text || c.delta || ''
          flushThink(false)
        } else if (c && c.type === 'tool-call-delta' && /__reply$/.test(String(c.name || ''))) {
          onReplyArgDelta(String(c.id || 'reply'), c.argumentsDelta || '')
        } else if (c && (c.type === 'text-delta' || c.type === 'finish')) {
          if (c.type === 'text-delta') {
            sawTextThisTurn = true // mute-verdict input
            const piece = c.text || c.delta || ''
            if (!replyArgStarted) streamBuf += piece // post-reply body text is meta, not draft
            if (turnText.length < PROMOTE_CAP * 2) turnText += piece
            flushStream(false)
          } else {
            flushStream(true) // step's prose is complete -- paint the tail
          }
          // Visible prose starting means the think block for this step is
          // complete -- flush the remainder so the fold never trails the reply.
          flushThink(true)
        }
      } else if (event.type === 'tool/call') {
        const d = event.data || {}
        log(`tool> ${d.name || '?'}`)
        if (isReplyClassTool(d.name)) sawReplyThisTurn = true
        // Retire the draft on EVERY tool call, not just reply-class (0.2.17,
        // the owner 08-27 17:08: a multi-step turn's step narration -- "확인해볼게"
        // / "비교해볼게" between tool calls -- accumulated into one glued
        // wall in the chat pane). Body text before a tool call is step
        // commentary: show it while the step is being written, wipe it when
        // the step fires, exactly like a status line. The delivered answer
        // never lives in the draft anyway (it rides the reply tool; body-only
        // answers are the mute-recovery fault class), and mute promotion
        // reads turnText, which keeps accumulating the full composed text.
        // For reply-class calls this is the same drop-stale-fragment fix as
        // before (a trailing 150ms flush would repaint beside the reply).
        if (streamTimer) { clearTimeout(streamTimer); streamTimer = null }
        streamBuf = ''
        if (streamedThisTurn) { postPresence('', 'stream', { done: true }); streamedThisTurn = false }
        flushThink(true) // reasoning that led to this call belongs above it
        try {
          const argsForLabel = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments || {})
          // Memory read: no label (activityLabelFor returns '' for every
          // mcp__ name), but the channel still has to hear about it -- this
          // is the lane's half of the memory mark.
          if (MEMORY_READ_TOOLS.has(String(d.name))) postPresence('', 'memory-read')
          const label = activityLabelFor(d.name, argsForLabel)
          if (label) postPresence(label)
          // Background roster bookkeeping: remember the subagent call's
          // display label until its result names the launched id; a
          // job_kill retires its target immediately.
          if (d.name === 'subagent' && d.callId) {
            pendingSubagentCalls.set(d.callId, truncLabel(argsForLabel.description || argsForLabel.prompt, 140))
            if (pendingSubagentCalls.size > 50) pendingSubagentCalls.delete(pendingSubagentCalls.keys().next().value)
          }
          if (d.name === 'job_kill' && argsForLabel.jobId) postPresence('', 'bg', { id: String(argsForLabel.jobId), done: true })
        } catch {}
        if (FILE_TOOLS.has(d.name)) {
          try {
            const args = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : (d.arguments || {})
            const p = args.file_path || args.path || args.notebook_path
            if (p) pendingToolPaths.set(d.callId, { tool: d.name, path: String(p) })
          } catch {}
        }
      } else if (event.type === 'tool/result') {
        const d = event.data || {}
        // callId sits at data.callId on tool/call but inside
        // data.message.source.callId on tool/result (measured session log).
        const callId = d.callId || (d.message && d.message.source && d.message.source.callId)
        // Background subagent launched: the result text names the id.
        const bgLabel = callId && pendingSubagentCalls.get(callId)
        if (bgLabel !== undefined) {
          pendingSubagentCalls.delete(callId)
          const m = eventMessageText(d).match(BG_STARTED_RE)
          if (m) {
            log(`subagent> background child ${m[1]} (${bgLabel || 'no label'})`)
            postPresence(bgLabel || 'background subagent', 'bg', { id: m[1] })
          }
        }
        const rec = callId && pendingToolPaths.get(callId)
        if (rec) {
          pendingToolPaths.delete(callId)
          let failed = false
          try {
            const parts = d.message && d.message.content
            if (Array.isArray(parts)) failed = parts.some((c) => c && c.isError === true)
          } catch {}
          const row = { ts: Date.now(), tool: rec.tool, path: rec.path }
          if (failed) row.failed = true
          ledgerAppend(row)
        }
      }
    },
    onClose () { if (!childExited) log('mux closed; events dark until restart') }
  })
  void mux

  // ── image markers (같이보기 / chat uploads / windowshot) ─────────────────
  // Inbound content carries "[image attached: <path> — …]" marker lines
  // (the Discord/chat-upload convention every surface shares). Three lanes
  // by route (see the DSH_VISION_SIDECAR comment at top):
  //   inline  -- the main model sees images: bytes ride as inline image
  //              parts, marker guidance rewritten to say so
  //   sidecar -- one-shot session on the sidecar model captions, marker
  //              rewritten to the 0.1.x caption format
  //   none    -- honest cannot-see rewrite (never invite a Read on a raster)
  // A marker that ALREADY carries an upstream caption (the app's ollama.com
  // fallback fires when laneVision says 'no') passes through untouched --
  // double-captioning would burn a sidecar call to overwrite better text.
  // PDF markers: pass through on inline routes (claude reads PDFs as
  // images upstream of 0.2 -- the marker's own guidance stands); honest
  // cannot-view note elsewhere.
  const IMG_MARKER_RE = /^\[image attached: (.+?)(?: — [^\]]*)?\]$/
  const PDF_MARKER_RE = /^\[PDF attached: (.+?)(?: — [^\]]*)?\]$/
  const UPSTREAM_CAPTION_RE = /cannot view images directly; a vision model/
  const RASTER_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }
  // 5MB: the gateway's own imageLimits.maxImageBytes (measured rc-7,
  // session.history metadata) -- larger files would be refused downstream.
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024
  const CAPTION_PROMPT = 'Describe this image thoroughly for someone who cannot see it: overall layout, ALL readable text verbatim, UI elements and their states, numbers, charts, people or objects, and anything unusual. Plain prose, no preamble. Do not use any tools.'
  async function captionImage (mediaType, filePath) {
    const data = fs.readFileSync(filePath).toString('base64')
    const s = await client.createSession({ cwd: MEM })
    const vsid = s.sessionId || s.id
    // Effort low: a caption is transcription, not reasoning -- and the
    // sidecar bills per image, so keep it cheap.
    try { await client.selectModel(vsid, DSH_PROVIDER, DSH_VISION_SIDECAR, 'low') } catch (e) {
      throw new Error(`vision model select failed: ${e.message}`)
    }
    const acc = await promptAndCollect(client, vsid, [
      { type: 'text', text: CAPTION_PROMPT },
      { type: 'image', mediaType, data, name: path.basename(filePath) }
    ], { timeoutMs: 120000 })
    const text = String(acc.text || '').trim()
    if (!text) throw new Error('vision model returned no text')
    return text
  }
  function readImagePart (filePath) {
    const mediaType = RASTER_EXT[path.extname(filePath).toLowerCase()]
    if (!mediaType) return null
    try {
      if (fs.statSync(filePath).size > MAX_IMAGE_BYTES) return null
      return { type: 'image', mediaType, data: fs.readFileSync(filePath).toString('base64'), name: path.basename(filePath) }
    } catch { return null }
  }
  // Returns { text, parts } -- parts non-empty only on inline routes.
  async function buildPromptContent (content) {
    const lines = []
    const parts = []
    for (const line of String(content).split('\n')) {
      const im = line.match(IMG_MARKER_RE)
      if (im) {
        if (UPSTREAM_CAPTION_RE.test(line)) { lines.push(line); continue }
        const p = im[1].trim()
        if (DSH_MODEL_VISION) {
          const part = readImagePart(p)
          if (part) {
            parts.push(part)
            lines.push(`[image attached: ${p} — the image itself is attached to this message]`)
            continue
          }
          lines.push(`[image attached: ${p} — NOTE: the file could not be attached; tell the user honestly that you cannot see it]`)
          continue
        }
        if (DSH_VISION_SIDECAR) {
          const mediaType = RASTER_EXT[path.extname(p).toLowerCase()]
          let ok = false
          try { ok = Boolean(mediaType) && fs.statSync(p).size <= MAX_IMAGE_BYTES } catch {}
          if (ok) {
            try {
              const caption = await captionImage(mediaType, p)
              // Brackets/newlines stripped, 2000 cap -- the marker must stay
              // one parseable line (mirror of chat.js markerFor's clean).
              const clean = caption.replace(/[\[\]]/g, '').replace(/\s*\n+\s*/g, ' ').slice(0, 2000)
              lines.push(`[image attached: ${p} — this model cannot view images directly; a vision model (${DSH_VISION_SIDECAR}) described it: "${clean}"]`)
              log(`captioned ${path.basename(p)} (${clean.length} chars)`)
              continue
            } catch (e) { errLog(`caption failed for ${p}: ${e.message.slice(0, 160)}`) }
          }
        }
        lines.push(`[image attached: ${p} — NOTE: this model cannot view images here; do not guess the contents, tell the user honestly that you cannot see it]`)
        continue
      }
      const pm = line.match(PDF_MARKER_RE)
      if (pm) {
        if (DSH_MODEL_VISION) { lines.push(line); continue }
        lines.push(`[PDF attached: ${pm[1].trim()} — NOTE: this lane cannot view PDFs; do not guess the contents, tell the user honestly]`)
        continue
      }
      lines.push(line)
    }
    return { text: lines.join('\n'), parts }
  }
  // Marker rewrite FIRST (on raw content, where the marker lines live),
  // channel tag SECOND (which entity-escapes the body) -- reversed order
  // would hide the markers from the caption pass behind escaping. Image
  // parts (inline routes) ride AFTER the text part.
  async function renderInbound (content, meta) {
    const built = await buildPromptContent(prependMemoryContext(content, meta))
    return [{ type: 'text', text: renderChannelTag({ content: built.text, meta: meta || {} }) }, ...built.parts]
  }

  // Redeliver anything the previous incarnation accepted but never finished.
  const stale = readPending()
  if (stale.length) {
    log(`redelivering ${stale.length} pending inbound message(s)`)
    for (const p of stale) {
      try {
        if (opensMuteGate({ channelId: (p.meta || {}).channelId, content: p.content })) turnHadUserInbound = true
        await client.prompt(sessionId, await renderInbound(p.content, p.meta))
        openTurn = true
      } catch (e) { errLog(`redelivery failed: ${e.message}`) }
    }
  }

  // ── ingest server (contract-parity with headless-lane) ────────────────────
  const token = randomBytes(24).toString('hex')
  const tokenBuf = Buffer.from(token)
  const tokenOk = (got) => {
    const gotBuf = Buffer.from(String(got || ''))
    return gotBuf.length === tokenBuf.length && timingSafeEqual(gotBuf, tokenBuf)
  }

  const server = createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    const host = String(req.headers.host || '')
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return send(403, { error: 'bad host' })
    if (req.method !== 'POST') return send(404, { error: 'not found' })
    // POST /interrupt (0.3.1): contract-parity with headless-lane. Same gate,
    // empty body, 409 when no turn is open. The FIFO is cleared BEFORE the
    // cancel for the identical reason (a withdrawn message must not come back
    // as a redelivery). The gateway's session.cancel ends the turn in place,
    // so unlike the claude lane there is no kill and no lane reboot here --
    // the session, and the turn's partial work, stay exactly where they are.
    if (req.url === '/interrupt') {
      if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
      if (childExited) return send(503, { error: 'agent not running' })
      if (!openTurn) return send(409, { error: 'no turn in flight' })
      openTurn = false
      if (!writePending([])) log('WARNING: pending FIFO clear failed -- the cancelled message may redeliver')
      log('user STOP: cancelling the in-flight turn via session.cancel (pending FIFO cleared)')
      client.cancel(sessionId).catch((e) => errLog(`session.cancel failed: ${e.message}`))
      return send(200, { ok: true, stopped: true })
    }
    if (req.url !== '/inbound') return send(404, { error: 'not found' })
    if (!tokenOk(req.headers['x-ingest-token'])) return send(403, { error: 'bad token' })
    let body = ''
    let tooLarge = false
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 256 * 1024 && !tooLarge) {
        tooLarge = true
        send(413, { error: 'too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      let payload
      try { payload = JSON.parse(body) } catch { return send(400, { error: 'invalid json' }) }
      const content = String(payload.content == null ? '' : payload.content).trim()
      if (!content) return send(400, { error: 'content required' })
      if (childExited) return send(503, { error: 'agent not running' })
      if (!writePending([...readPending(), { content, meta: payload.meta || {}, ts: Date.now() }])) {
        return send(500, { error: 'pending persist failed' })
      }
      if (opensMuteGate({ channelId: (payload.meta || {}).channelId, content })) turnHadUserInbound = true
      // Answer-stream gate: remember where this turn came from. The local
      // surface's notifier sends no channelId (renderChannelTag defaults it
      // to 'in-app'); platform backends send their real channel id.
      lastInboundChannelId = String((payload.meta || {}).channelId || 'in-app')
      openTurn = true // /interrupt is answerable from here until turn/end
      renderInbound(content, payload.meta)
        .then((parts) => client.prompt(sessionId, parts))
        .then(() => log(`inbound -> session (${content.length} chars, sender=${(payload.meta && payload.meta.sender) || '?'})`))
        .catch((e) => errLog(`prompt failed: ${e.message}`))
      send(200, { ok: true })
    })
  })

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    try {
      writeJsonAtomic(endpointFile(), { port, token, pid: process.pid }, 0o600)
      log(`ingest endpoint on 127.0.0.1:${port}`)
    } catch (e) {
      errLog(`endpoint file write failed: ${e.message}`)
      process.exit(1)
    }
  })

  // First beat now, so the supervisor sees this era's marker immediately
  // rather than 15s into a boot it might already be judging.
  writeHeartbeat()
  const heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_MS)
  heartbeatTimer.unref()

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(heartbeatTimer)
    killEngine(child)
    try { fs.unlinkSync(endpointFile()) } catch {}
    try { fs.unlinkSync(heartbeatFile()) } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  // The STOPFLAG is the ONLY portable stop channel (design-0023 P3 #2).
  // Windows has no deliverable SIGTERM -- node's process.kill there is
  // TerminateProcess, so neither handler above ever runs and this lane used to
  // be hard-killed with the engine mid-write and .ingest-endpoint.json left
  // behind for the next boot to trip over. The supervisor's stop writes
  // $MEM/.stop_requested first and then waits out a grace window, so polling
  // it here is what makes that window mean anything. Cheap (one existsSync per
  // 500ms), unref'd so it never holds the loop open, and correct on POSIX too
  // -- there it is a belt for a signal that got lost.
  const stopflag = path.join(MEM, '.stop_requested')
  const stopWatch = setInterval(() => {
    if (!fs.existsSync(stopflag)) return
    log('stop requested (.stop_requested) -- shutting down')
    clearInterval(stopWatch)
    shutdown()
  }, 500)
  stopWatch.unref()
}

main().catch((e) => { errLog(`boot failed: ${e.message}`); killEngine(child); process.exit(1) })
