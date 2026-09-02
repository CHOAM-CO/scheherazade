// test-subagent-containment.mjs -- delegated children cannot reach the chat.
// Run: node scripts/test-subagent-containment.mjs
//
// Field-caught (Mino cto mac, 2026-08-20, GPT 5.6 Sol): "서브에이전트 메세지가
// 계속 인앱챗으로 역류함". A delegated child joins the parent's preset
// (session header agentPreset: schz-standard, measured live), so it inherited
// the agent-channel reply/react MCP tools AND the persona ordering "answer
// through the reply tool" -- children messaged the user directly. The fix is
// dsh-lane's guardSubagentRows(): containment rows written into the authored
// preset. Live verification 2026-08-20: adversarial parent instruction
// ("tell the subagent to report directly to the user") -> child session
// carried ZERO reply-tool definitions, the worker persona, and the child
// itself reported the tool was unavailable.
//
// The lane is not importable (module-scope servers), so this test EXTRACTS
// guardSubagentRows + its consts from the source and executes the real code
// against the REAL shipped preset yaml -- transform behavior, not just pins.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')

let passed = 0
let failed = 0
function assert (cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`) } else { failed++; console.log(`  FAIL ${msg}`) }
}

// ── extract the real transform ──────────────────────────────────────────────
function extract (name, kind) {
  const start = src.indexOf(`${kind} ${name}`)
  if (start === -1) return null
  if (kind === 'const') {
    // const spans to the first line that ends a statement without continuation
    const tail = src.slice(start)
    const m = tail.match(/^const [\s\S]*?(?:'|")\n(?=\S|\n)/m)
    return m ? m[0] : null
  }
  // function: to the first closing brace at column 0
  const tail = src.slice(start)
  const end = tail.indexOf('\n}')
  return end === -1 ? null : tail.slice(0, end + 2)
}
const fnSrc = extract('guardSubagentRows', 'function')
const denySrc = extract('SUBAGENT_DENY', 'const')
const personaSrc = extract('SUBAGENT_PERSONA', 'const')
assert(!!fnSrc, 'guardSubagentRows exists in dsh-lane.mjs')
assert(!!denySrc && !!personaSrc, 'SUBAGENT_DENY / SUBAGENT_PERSONA consts exist')

const ctx = {}
vm.createContext(ctx)
vm.runInContext(`${denySrc}\n${personaSrc}\n${fnSrc}`, ctx)
const guardSubagentRows = ctx.guardSubagentRows

// ── run it on the REAL shipped preset ───────────────────────────────────────
const shipped = path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'config', 'agent-presets', 'standard', 'agent.cordis.yml')
assert(fs.existsSync(shipped), `shipped standard preset exists (${path.relative(ROOT, shipped)})`)
const out = guardSubagentRows(fs.readFileSync(shipped, 'utf8'))

// 1. both ACTIVE subagent rows gain the containment config
const denyCount = (out.match(/deny: \[mcp__agent-channel__reply, mcp__agent-channel__react\]/g) || []).length
assert(denyCount === 2, `toolFilter.deny lands on exactly the two continuable rows (got ${denyCount})`)
const personaCount = (out.match(/You are a background subagent doing one delegated task/g) || []).length
assert(personaCount === 2, `worker persona override lands on exactly the two continuable rows (got ${personaCount})`)
// the deny must sit under a toolFilter: key at deeper indent (valid yaml shape)
assert(/^(\s+)toolFilter:\n\1 {2}deny: \[/m.test(out), 'toolFilter block is indented as a child mapping')

// 2. uncontainable spawn paths are disabled
for (const id of ['tool-ralph', 'tool-workflow']) {
  const row = out.indexOf(`- id: ${id}\n`)
  assert(row !== -1, `${id} row still present (disabled, not deleted)`)
  const window = out.slice(row, row + 300)
  assert(/disabled: true # dsh-lane: children inherit the channel surface unfiltered/.test(window),
    `${id} row is disabled with the containment rationale`)
}

// 3. the one-shot disabled variants are untouched (no double-guarding)
const codexRow = out.slice(out.indexOf('- id: tool-subagent-codex'), out.indexOf('- id: tool-subagent-claude-code'))
assert(!codexRow.includes('toolFilter'), 'one-shot codex variant row is untouched')

// 4. idempotence guard rail: running twice must not stack more containment
const twice = guardSubagentRows(out)
const denyTwice = (twice.match(/deny: \[mcp__agent-channel__reply, mcp__agent-channel__react\]/g) || []).length
assert(denyTwice === 2, `transform is idempotent on deny rows (got ${denyTwice})`)

// 5. source pin: ensureLanePreset actually calls the guard
assert(/filtered = guardSubagentRows\(filtered, subagentAgentOptions\(\)\)/.test(src), 'ensureLanePreset routes the authored preset through guardSubagentRows (with the model pin)')

// 4. subagent model pin (0.2.19, Sera field report 2026-09-02): agentOptions
// rows land on the same two continuable rows, valid child-mapping yaml, and
// only when a pin is passed -- the bare call (how this test ran the shipped
// yaml above) must stay pin-free so declared-route behavior is explicit.
assert(!/agentOptions:/.test(out), 'no agentOptions rows without a pin argument')
const pinned = guardSubagentRows(fs.readFileSync(shipped, 'utf8'), { provider: 'anthropic', model: 'claude-sonnet-5' })
const pinCount = (pinned.match(/agentOptions:\n\s+provider: anthropic\n\s+model: claude-sonnet-5/g) || []).length
assert(pinCount === 2, `agentOptions pin lands on exactly the two continuable rows (got ${pinCount})`)
assert(/^(\s+)agentOptions:\n\1 {2}provider: anthropic\n\1 {2}model: claude-sonnet-5$/m.test(pinned), 'agentOptions block is indented as a child mapping')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
