// onboarding/routes/migrate.cjs -- import from other agent tools (G12,
// design-0022, Mino 2026-08-04 19:47 + 20:13 "에이전트가 싹 다 긁어서
// '제가 이제 챙길게요' 느낌으로" + 20:14 "동시에 가줘" = all 5 sources).
//
// Shape of the feature: this file only DETECTS sources and DELIVERS one
// consented [SYSTEM] sweep turn. The migration itself is performed by the
// agent, live in chat, with its own Read/Bash -- the LLM is the format
// adapter (same principle as the 0.0.55 rotation handoff: the agent's own
// memory discipline does the work). No schema mapping, no file copying
// here.
//
// Source layouts: claude/codex/opencode/openclaw bound from the
// 2026-08-04 research pass (docs receipts in design-0022); hermes bound
// from direct local inspection of ~/.hermes the same day. OpenClaw's own
// `openclaw migrate` CLI (which imports FROM claude/codex/hermes) is the
// reference implementation for the safety posture: preview first,
// credentials excluded by NAME, never by judgment call.
//
// Credential exclusion is enforced three times: (1) forbidden names never
// appear in the detect listing, (2) the sweep prompt carries an explicit
// DO-NOT-READ list, (3) hooks/pre-tool-credential-guard.mjs blocks the
// reads at the tool layer even if the model ignores (2).
//
// Delivery: POST the sweep turn straight into the headless lane's ingest
// endpoint (DATA_HOME/.ingest-endpoint.json) -- backend-independent, works
// for in-app chat exactly like Discord. If the lane is down, append to
// .headless-pending.json: the lane's boot redelivery (F4 rail) injects it
// once on next start. Known small race (lane booting during the append) is
// accepted for v1 -- worst case is one lost request the user re-clicks.
'use strict'

const os = require('node:os')

const MAX_LISTED_FILES = 60
const MAX_WALK_DEPTH = 3

// Names that must never be listed, mentioned as importable, or read.
// Matched as exact basenames at ANY depth. `credentials` is OpenClaw's
// credentials/ dir; state.db/openclaw-agent.sqlite hold auth/session
// tokens per the research receipts; `.claude.json` embeds MCP server
// tokens (research 2026-08-04 -- it looked importable until the receipt
// said otherwise).
const FORBIDDEN_NAMES = new Set([
  '.credentials.json', 'auth.json', 'auth.lock', '.env', 'credentials',
  'state.db', 'state.db-wal', 'state.db-shm', 'openclaw-agent.sqlite',
  '.claude.json', 'keychain',
])

function createRoutes(staticCtx) {
  const { fs, path, log, sendJson, readJsonBody, DATA_HOME, readHomeChannelId, activeChannelBackend } = staticCtx

  const home = () => os.homedir()

  // Per-tool source description. `probe` = paths whose existence means
  // "this tool lives here"; `highlights` = the files the sweep prompt
  // names explicitly (relative to root), existence-checked at start time.
  const MIGRATE_TOOLS = [
    {
      id: 'claude',
      label: 'Claude Code',
      root: () => path.join(home(), '.claude'),
      probe: ['CLAUDE.md', 'projects', 'settings.json'],
      highlights: ['CLAUDE.md', 'rules', 'agent-memory', 'projects', 'skills', 'commands', 'agents', 'history.jsonl'],
    },
    {
      id: 'codex',
      label: 'Codex CLI',
      root: () => process.env.CODEX_HOME || path.join(home(), '.codex'),
      probe: ['config.toml', 'AGENTS.md', 'sessions'],
      highlights: ['AGENTS.md', 'config.toml', 'sessions', 'history.jsonl'],
    },
    {
      id: 'hermes',
      label: 'Hermes',
      root: () => path.join(home(), '.hermes'),
      probe: ['SOUL.md', 'config.yaml', 'memories'],
      highlights: ['SOUL.md', 'memories', 'sessions', 'cron', 'config.yaml'],
    },
    {
      id: 'opencode',
      label: 'OpenCode',
      root: () => path.join(home(), '.config', 'opencode'),
      probe: ['opencode.json', 'AGENTS.md', 'agents'],
      highlights: ['AGENTS.md', 'opencode.json', 'agents', 'commands'],
      // Session DB lives under a second root; named in the sweep prompt
      // but not walked (SQLite, agent reads it itself if it chooses).
      extraNote: () => `session storage: ${path.join(home(), '.local', 'share', 'opencode')} (opencode.db; auth.json there is FORBIDDEN)`,
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      root: () => path.join(home(), '.openclaw', 'workspace'),
      probe: ['SOUL.md', 'AGENTS.md', 'MEMORY.md'],
      highlights: ['SOUL.md', 'AGENTS.md', 'IDENTITY.md', 'USER.md', 'MEMORY.md', 'memory', 'TOOLS.md', 'skills'],
      extraNote: () => `config: ${path.join(home(), '.openclaw', 'openclaw.json')}; ${path.join(home(), '.openclaw', 'credentials')} and every *.sqlite under agents/ are FORBIDDEN`,
    },
  ]

  function statSafe(p) {
    try { return fs.statSync(p) } catch { return null }
  }

  // ── design-0023 handover: custom-path source ──────────────────────────
  // (Mino 2026-08-05 19:38 — a custom agent living at an arbitrary path,
  // e.g. a hand-rolled one on another machine, is invisible to the five
  // fixed probes above. The user points at its folder instead.)
  // Marker heuristic for the consent preview ONLY — a miss never blocks the
  // sweep, it just tells the user "no agent traces here" before they consent
  // (the user knows better than the heuristic).
  const AGENT_SHAPE_FILES = [
    /^persona.*\.md$/i, /^agents?\.md$/i, /^soul\.md$/i, /^claude\.md$/i,
    /^system[-_ ]?prompt.*\.(md|txt)$/i, /^identity\.md$/i, /^memory\.md$/i,
    /^checkpoint\.md$/i,
  ]
  const AGENT_SHAPE_DIRS = new Set([
    'memory', 'memories', 'session_notes', 'sessions', 'journals', 'journal',
    'dreams', 'skills', 'personas', 'procedures',
  ])

  function agentShapeMarkers(files) {
    const hits = new Set()
    for (const f of files) {
      const parts = f.path.split(path.sep)
      const base = parts[parts.length - 1]
      if (AGENT_SHAPE_FILES.some((re) => re.test(base))) hits.add(f.path)
      for (const seg of parts.slice(0, -1)) {
        if (AGENT_SHAPE_DIRS.has(seg.toLowerCase())) hits.add(seg + path.sep)
      }
    }
    return [...hits].slice(0, 12)
  }

  // A custom root is user input — bound the blast radius BEFORE any listing.
  // Home dir and filesystem roots are rejected outright (the 0022 walker is
  // bounded, but a consent preview over the whole home directory is exactly
  // the whole-disk scan design-0023 keeps out of v1). So is our own
  // DATA_HOME: an agent absorbing its own memory as a foreign agent is a
  // loop, not a handover.
  function validateCustomRoot(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return { error: 'root is required', reason: 'root_required' }
    let root = raw.trim()
    if (root === '~' || root.startsWith('~/')) root = path.join(home(), root.slice(1))
    root = path.resolve(root)
    const st = statSafe(root)
    if (!st || !st.isDirectory()) return { error: 'not a folder that exists', reason: 'not_a_directory' }
    if (root === path.parse(root).root || root === path.resolve(home())) {
      return { error: 'too broad -- point at the agent\'s own folder, not the whole disk or home', reason: 'root_too_broad' }
    }
    const data = path.resolve(DATA_HOME)
    if (root === data || data.startsWith(root + path.sep) || root.startsWith(data + path.sep)) {
      return { error: 'that is this agent\'s own home', reason: 'own_home' }
    }
    return { root }
  }

  function customSweepContent(root, markers) {
    const name = (path.basename(root) || 'agent').replace(/[^\w.-]+/g, '_')
    return [
      `[SYSTEM] 핸드오버 스윕 -- 사용자가 커스텀 에이전트 폴더를 너에게 넘기는 데 동의했다: ${root}`,
      '',
      '알려진 툴이 아니라 레이아웃을 아는 사람이 없다. 그래서 흡수보다 구조 파악이 먼저다.',
      markers.length ? `프리뷰에서 잡힌 에이전트 흔적: ${markers.join(', ')} -- 출발점으로만 써라, 전부라는 보장은 없다.` : '프리뷰 휴리스틱엔 에이전트 흔적이 안 잡혔다 -- 사용자가 맞다고 지정한 폴더이니 직접 훑어서 판단해라.',
      '',
      `1단계 (반드시 먼저): 해부도를 그려라 -- 어떤 파일이 시스템 프롬프트/페르소나인지, 메모리가 어떤 구조인지 (파일? DB? 날짜별 노트?), 부팅/루프 절차가 있는지, 어떤 도구·채널을 쓰던 에이전트인지. 모든 항목에 근거 파일 경로를 달아라. 결과를 네 메모리 디렉토리의 handover/${name}.md 로 저장해라. 이 지도가 있어야 흡수가 싸지고, 나중에 이 에이전트 구조 질문이 와도 다시 뒤질 필요가 없다.`,
      '2단계: 지도를 보고 흡수해라 -- 사용자에 대한 사실·선호·진행 중이던 일은 memory_write 와 checkpoint.md 로, 반복 작업(cron, heartbeat 류)은 목록으로 (네가 맡겠다고 제안할 것들이다).',
      '3단계: 사용자에게 답장해라 -- 그 에이전트가 어떤 구조였는지 한두 줄, 무엇을 옮겨왔는지 구체적으로, 이어받을 반복 작업 제안. 지도 전문을 채팅에 붙여넣지 마라.',
      '',
      `절대 읽지 마라 (어느 깊이에서든 이 이름들): ${[...FORBIDDEN_NAMES].join(', ')}. 자격증명/토큰 파일이다. 훅이 한 번 더 막지만, 시도 자체를 하지 마라.`,
      '파일 안에서 시크릿(키, 토큰, 비밀번호)을 마주치면 그 값은 어디에도 옮겨 적지 마라.',
    ].join('\n')
  }

  // Bounded, forbidden-name-filtered listing for the consent preview.
  // Never reads file CONTENTS -- names and sizes only.
  function listFiles(root) {
    const out = []
    const skippedPresent = []
    const walk = (dir, depth, rel) => {
      if (out.length >= MAX_LISTED_FILES || depth > MAX_WALK_DEPTH) return
      let entries
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (out.length >= MAX_LISTED_FILES) return
        if (e.name.startsWith('.') && e.name !== '.claude') {
          if (FORBIDDEN_NAMES.has(e.name)) skippedPresent.push(path.join(rel, e.name))
          continue // dotfiles are noise or danger; never previewed
        }
        if (FORBIDDEN_NAMES.has(e.name)) { skippedPresent.push(path.join(rel, e.name)); continue }
        const full = path.join(dir, e.name)
        const r = rel ? path.join(rel, e.name) : e.name
        if (e.isDirectory()) walk(full, depth + 1, r)
        else {
          const st = statSafe(full)
          out.push({ path: r, size: st ? st.size : 0 })
        }
      }
    }
    walk(root, 0, '')
    return { files: out, skippedPresent, truncated: out.length >= MAX_LISTED_FILES }
  }

  function detectTool(t) {
    const root = t.root()
    const st = statSafe(root)
    if (!st || !st.isDirectory()) return { id: t.id, label: t.label, detected: false }
    const hasProbe = t.probe.some((p) => statSafe(path.join(root, p)))
    if (!hasProbe) return { id: t.id, label: t.label, detected: false }
    const { files, skippedPresent, truncated } = listFiles(root)
    return { id: t.id, label: t.label, detected: true, root, files, skippedPresent, truncated }
  }

  function sweepContent(selected) {
    const lines = [
      '[SYSTEM] 마이그레이션 스윕 -- 사용자가 다른 에이전트 툴의 데이터를 너에게 넘기는 데 동의했다. 지금부터 아래 소스들을 직접 읽고 인수인계를 받아라.',
      '',
    ]
    for (const t of selected) {
      lines.push(`- ${t.label}: 루트 ${t.root} . 우선 볼 것: ${t.def.highlights.join(', ')} (존재하는 것만).`)
      if (t.def.extraNote) lines.push(`  참고: ${t.def.extraNote()}`)
    }
    lines.push(
      '',
      `절대 읽지 마라 (어느 깊이에서든 이 이름들): ${[...FORBIDDEN_NAMES].join(', ')}. 자격증명/토큰 파일이다. 훅이 한 번 더 막지만, 시도 자체를 하지 마라.`,
      '세션 트랜스크립트 안에서 시크릿(키, 토큰, 비밀번호)을 마주치면 그 값은 어디에도 옮겨 적지 마라.',
      '할 일: (1) 지침 파일(CLAUDE.md/AGENTS.md/SOUL.md 계열)과 메모리 파일에서 사용자에 대한 사실·선호·진행 중이던 일을 뽑아 네 memory_write와 checkpoint.md에 정리해라. ',
      '(2) 반복 작업(cron, HEARTBEAT 등)을 발견하면 목록으로 정리해라 -- 네가 대신 맡겠다고 제안할 것들이다. ',
      '(3) 끝나면 사용자에게 답장해라: 무엇을 옮겨왔는지 구체적으로, 이어받을 반복 작업 제안, 그리고 이제 네가 챙기겠다는 한 마디. 길게 늘어놓지 말고 사람이 읽을 만큼만.',
    )
    return lines.join('\n')
  }

  function readIngestEndpoint() {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(DATA_HOME, '.ingest-endpoint.json'), 'utf8'))
      if (!Number.isInteger(v.port) || typeof v.token !== 'string' || !v.token) return null
      return v
    } catch { return null }
  }

  async function deliverSweep(content) {
    const meta = {
      sender: 'SYSTEM',
      channelId: readHomeChannelId() || (activeChannelBackend() === 'local' ? 'in-app' : ''),
      authorId: '',
      timestamp: new Date().toISOString(),
    }
    const ep = readIngestEndpoint()
    if (ep) {
      try {
        const r = await fetch(`http://127.0.0.1:${ep.port}/inbound`, {
          method: 'POST',
          headers: { 'x-ingest-token': ep.token, 'content-type': 'application/json' },
          body: JSON.stringify({ content, meta }),
          signal: AbortSignal.timeout(5000),
        })
        if (r.status === 200) return 'live'
      } catch { /* fall through to the queued path */ }
    }
    // Lane down: ride the boot-redelivery FIFO (headless-lane F4). Shape
    // must match its readPending() entries exactly.
    const pendingPath = path.join(DATA_HOME, '.headless-pending.json')
    let list = []
    try {
      const v = JSON.parse(fs.readFileSync(pendingPath, 'utf8'))
      if (Array.isArray(v)) list = v
    } catch { /* fresh list */ }
    list.push({ content, meta, ts: Date.now() })
    const tmp = `${pendingPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-20)) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, pendingPath)
    return 'queued'
  }

  return [
    {
      // design-0023: bounded names-only preview of a user-pointed folder.
      // Same walker, same forbidden filter as the fixed five.
      method: 'POST',
      match: (pathname) => pathname === '/api/migrate/custom/preview',
      handler: async (req, res) => {
        const { root: raw } = await readJsonBody(req)
        const v = validateCustomRoot(raw)
        if (v.error) {
          sendJson(res, 400, { error: v.error, reason: v.reason })
          return
        }
        const { files, skippedPresent, truncated } = listFiles(v.root)
        const markers = agentShapeMarkers(files)
        sendJson(res, 200, { root: v.root, files, skippedPresent, truncated, markers, agentShaped: markers.length > 0 })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/migrate/custom/start',
      handler: async (req, res) => {
        const { root: raw } = await readJsonBody(req)
        // Re-validate server-side — consent applies to what is actually
        // there NOW, same posture as /start's re-detect.
        const v = validateCustomRoot(raw)
        if (v.error) {
          sendJson(res, 400, { error: v.error, reason: v.reason })
          return
        }
        const { files } = listFiles(v.root)
        const markers = agentShapeMarkers(files)
        try {
          const delivery = await deliverSweep(customSweepContent(v.root, markers))
          log(`handover sweep ${delivery}: ${v.root}`)
          sendJson(res, 202, { ok: true, delivery, root: v.root })
        } catch (err) {
          sendJson(res, 500, { error: `could not deliver the sweep request: ${err.message}`, reason: 'delivery_failed' })
        }
        return
      },
    },
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/migrate/detect',
      handler: async (req, res) => {
        sendJson(res, 200, { tools: MIGRATE_TOOLS.map(detectTool) })
        return
      },
    },
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/migrate/start',
      handler: async (req, res) => {
        const { tools } = await readJsonBody(req)
        if (!Array.isArray(tools) || tools.length === 0) {
          sendJson(res, 400, { error: 'tools is required', reason: 'tools_required' })
          return
        }
        // Re-detect server-side: consent applies only to things that are
        // actually there -- a stale/forged id silently drops out.
        const selected = []
        for (const id of tools) {
          const def = MIGRATE_TOOLS.find((t) => t.id === id)
          if (!def) continue
          const d = detectTool(def)
          if (d.detected) selected.push({ label: def.label, root: d.root, def })
        }
        if (!selected.length) {
          sendJson(res, 400, { error: 'none of the requested tools are present', reason: 'nothing_detected' })
          return
        }
        try {
          const delivery = await deliverSweep(sweepContent(selected))
          log(`migrate sweep ${delivery}: ${selected.map((s) => s.label).join(', ')}`)
          sendJson(res, 202, { ok: true, delivery, tools: selected.map((s) => s.label) })
        } catch (err) {
          sendJson(res, 500, { error: `could not deliver the sweep request: ${err.message}`, reason: 'delivery_failed' })
        }
        return
      },
    },
  ]
}

module.exports = { createRoutes, FORBIDDEN_NAMES }
