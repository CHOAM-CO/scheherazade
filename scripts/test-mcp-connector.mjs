#!/usr/bin/env node
// test-mcp-connector.mjs -- the claude.ai connector intercept, attacked at
// its pure surfaces (no `claude mcp login` spawn anywhere: authorizing a
// connector has a REAL remote side effect on the tester's account, so this
// file stops at the parser, the URL regex, the lane gate, and source pins).
//
// The promises that matter, in order:
//   1. The two 🔒 fixes 춘식3 flagged are LOAD-BEARING in code:
//      (a) the URL regex REQUIRES the ?product_surface=sdk-cli query -- a
//          bare authorize URL without it is a MISS (bad URL = no approval).
//      (b) stdout is ACCUMULATED across chunks, never matched per-chunk (a
//          URL split across a chunk boundary must still be captured).
//   2. The lane gate is honest: only the verified subscription lane
//      (claude-cli) is greenlit; every key/base_url lane warns.
//   3. The list parser survives REAL output (health preamble, ⏸ Pending
//      local servers, ✔ Connected connectors) and keeps only claude.ai rows.
//
// Run: node scripts/test-mcp-connector.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.AGENT_DATA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-mcp-'))
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { parseMcpConnectorList, MCP_CONNECTOR_SPEC, connectorLaneWarning } = require_(path.join(ROOT, 'onboarding', 'http-server.cjs'))

let pass = 0
let fail = 0
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

console.log('mcp connector intercept (parser + url regex + lane gate)\n')

// ── 1a. FIX #1: the query is MANDATORY ─────────────────────────────────────
{
  const re = MCP_CONNECTOR_SPEC.urlRegex
  const good = 'https://claude.ai/api/organizations/69f0c676-9d75-487b-86f7-55d2c48d2058/mcp/start-auth/mcpsrv_01PhEKoNkyRQHS975d1qAof1?product_surface=sdk-cli'
  const noQuery = 'https://claude.ai/api/organizations/69f0/mcp/start-auth/mcpsrv_01Ph'
  const wrongQuery = 'https://claude.ai/api/organizations/69f0/mcp/start-auth/mcpsrv_01Ph?product_surface=web'
  check('the real authorize URL (with ?product_surface=sdk-cli) matches', re.test(good))
  check('a URL WITHOUT the query is a MISS (bare URL = no approval page)', !re.test(noQuery), 'bare url wrongly matched')
  check('a URL with the WRONG product_surface is a MISS', !re.test(wrongQuery), 'wrong surface wrongly matched')
  check('origin is pinned to https://claude.ai (no other host can match)',
    !re.test('https://evil.example/api/organizations/x/mcp/start-auth/mcpsrv_y?product_surface=sdk-cli'))
  // Captured substring from mixed stdout is exactly the URL, nothing trailing-greedy past whitespace.
  const m = ('Visit this URL to authorize:\n  ' + good + '\nOnce authorized...').match(re)
  check('captures the URL cleanly out of surrounding stdout', m && m[0] === good, m && m[0])
}

// ── 1b. FIX #2: accumulation, proven by the regex against a SPLIT feed ─────
// The driver accumulates stdout then matches the buffer. Re-create that here:
// a per-chunk match would fail on each half; the accumulated buffer matches.
{
  const url = 'https://claude.ai/api/organizations/abc/mcp/start-auth/mcpsrv_z9?product_surface=sdk-cli'
  const chunkA = 'Visit this URL to authorize:\n  https://claude.ai/api/organizations/abc/mcp/start-'
  const chunkB = 'auth/mcpsrv_z9?product_surface=sdk-cli\nOnce authorized...'
  check('neither half matches alone (why per-chunk matching loses the URL)',
    !MCP_CONNECTOR_SPEC.urlRegex.test(chunkA) && !MCP_CONNECTOR_SPEC.urlRegex.test(chunkB))
  const buf = chunkA + chunkB
  const m = buf.match(MCP_CONNECTOR_SPEC.urlRegex)
  check('the ACCUMULATED buffer matches (the fix)', m && m[0] === url, m && m[0])
  // Source pin: the driver actually accumulates + guards against per-chunk.
  const src = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  const drv = src.slice(src.indexOf('function startMcpConnectorLogin'), src.indexOf('async function handleApi'))
  check('driver accumulates stdout (stdoutBuf += chunk)', drv.includes('stdoutBuf += chunk'))
  check('driver matches the BUFFER, not the raw chunk', drv.includes('stdoutBuf.match(MCP_CONNECTOR_SPEC.urlRegex)'))
  check('driver stops re-matching once captured (late chunk cannot overwrite)', /if \(capturedUrl\) return/.test(drv))
}

// ── 2. lane gate is honest ─────────────────────────────────────────────────
{
  check('claude-cli lane is greenlit (no warning)', connectorLaneWarning({ PROVIDER: 'claude-cli' }) === null)
  check('default/undefined lane treated as claude-cli (no warning)', connectorLaneWarning({}) === null)
  // The suppressor is ANTHROPIC_API_KEY, not base_url (empirical 07-14). Each
  // of these lanes WARNS because it injects a key -- chatgpt a placeholder,
  // ollama the literal 'ollama', claude a real BYOK key (provider-env.cjs).
  check('chatgpt lane WARNS (injects placeholder key -> suppresses)', connectorLaneWarning({ PROVIDER: 'chatgpt' }) === 'chatgpt')
  check('ollama lane WARNS (injects key=ollama -> suppresses)', connectorLaneWarning({ PROVIDER: 'ollama' }) === 'ollama')
  check('claude BYOK lane WARNS (injects real key -> suppresses)', connectorLaneWarning({ PROVIDER: 'claude' }) === 'claude')
  check('claude-subscription WARNS (setup-token connector loading UNVERIFIED -- fail toward honesty)',
    connectorLaneWarning({ PROVIDER: 'claude-subscription' }) === 'claude-subscription')
}

// ── 3. list parser against REAL output ─────────────────────────────────────
{
  const real = [
    'Checking MCP server health…',
    '',
    'claude.ai Google Calendar: https://calendarmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected',
    'claude.ai Atlassian: https://mcp.atlassian.com/v1/mcp - ! Needs authentication',
    'context7: npx -y @upstash/context7-mcp - ✔ Connected',
    'agent-channel: node ./channel.mjs - ⏸ Pending approval (run `claude` to approve)',
    'memory: node ./memory/server.mjs - ⏸ Pending approval (run `claude` to approve)',
  ].join('\n')
  const parsed = parseMcpConnectorList(real)
  check('keeps ONLY claude.ai connectors (3), drops local + third-party rows', parsed.length === 3, JSON.stringify(parsed.map((p) => p.name)))
  check('skips the health-check preamble line', !parsed.some((p) => /Checking/.test(p.name)))
  check('strips the "claude.ai " prefix from names', parsed[0].name === 'Google Calendar')
  check('maps ✔ Connected -> connected', parsed.find((p) => p.name === 'Gmail').status === 'connected')
  check('maps ! Needs authentication -> needs_auth', parsed.find((p) => p.name === 'Atlassian').status === 'needs_auth')
  check('drops local ⏸ Pending servers (agent-channel/memory are not connectors)',
    !parsed.some((p) => p.name === 'agent-channel' || p.name === 'memory'))
  check('empty output -> empty list (no crash)', parseMcpConnectorList('').length === 0)
}

// ── 4. source pins: routes + env scrub + injected bin + cleanup ────────────
{
  // Route BODIES moved to onboarding/routes/mcp-connectors.cjs (issue #9
  // PR-2); the login-driver internals (startMcpConnectorLogin, env scrub,
  // killAllLoginChildren) stay in http-server.cjs. Same assertions, split
  // across the two homes.
  const src = fs.readFileSync(path.join(ROOT, 'onboarding', 'http-server.cjs'), 'utf8')
  const routeSrc = fs.readFileSync(path.join(ROOT, 'onboarding', 'routes', 'mcp-connectors.cjs'), 'utf8')
  check('GET /api/mcp-connectors route exists', routeSrc.includes("'/api/mcp-connectors'"))
  check('POST /api/mcp-connector/login route exists', routeSrc.includes("'/api/mcp-connector/login'"))
  check('GET /api/mcp-connector/status route exists', routeSrc.includes("'/api/mcp-connector/status'"))
  check('login route reports the lane warning to the UI', routeSrc.includes('laneWarning'))
  check('CHILD env scrubs ANTHROPIC_API_KEY (connectors are suppressed by it)',
    /delete childEnv\.ANTHROPIC_API_KEY/.test(src))
  check('parent env is never mutated (only childEnv is deleted from)',
    !src.includes('delete process.env.ANTHROPIC_API_KEY'))
  check('bin comes from the injected resolver, not http-server resolveBin',
    routeSrc.includes('agentControls.resolveClaudeBin()') && !routeSrc.includes("resolveBin('claude')") && !src.includes("resolveBin('claude')"))
  check('mcp auth children ride the app-quit cleanup (killAllLoginChildren sweeps them)',
    src.slice(src.indexOf('function killAllLoginChildren')).includes('mcpLoginChildren'))

  const main = fs.readFileSync(path.join(ROOT, 'main.cjs'), 'utf8')
  check('main.cjs injects resolveClaudeBin into agentControls', /resolveClaudeBin: \(\) =>/.test(main))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
