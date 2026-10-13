// tests/test-claude-auth-fallback.mjs -- Claude lane token resolution order
// and the AUTH banner's extra fix (2026-10-13, field report sanha: Settings
// Re-login wrote 'claude-subscription' but the claude-cli route never read
// it). Fake stores only; never touches the real CLI login or safeStorage.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveClaudeLaneToken, claudeAuthLoginHint, buildProviderEnv } from '../provider-env.cjs'

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`PASS ${label}`) } else { fail++; console.log(`FAIL ${label}`) }
}

const NOW = 1_800_000_000_000
const now = () => NOW
const cliOk = () => ({ token: 'sk-ant-oat01-cli', expiresAt: NOW + 3_600_000 })
const cliExpired = () => ({ error: 'the Claude Code CLI login token is expired (or about to expire)' })
const cliMissing = () => ({ error: 'no Claude Code CLI login found' })
const subBlob = (exp) => () => JSON.stringify({ accessToken: 'sk-ant-oat01-sub', refreshToken: 'r', expiresAt: exp })
const subBare = () => 'sk-ant-oat01-sub-bare'
const subNone = () => null

// claude-cli route
{
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliExpired, readSub: subBlob(NOW + 3_600_000), now })
  assert(r.token === 'sk-ant-oat01-sub' && r.source === 'claude-subscription', 'cli expired + subscription valid -> subscription')
}
{
  let subReads = 0
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliOk, readSub: () => { subReads++; return subBare() }, now })
  assert(r.token === 'sk-ant-oat01-cli' && r.source === 'claude-cli', 'both valid -> cli')
  assert(subReads === 0, 'both valid -> subscription slot not even read')
}
{
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliMissing, readSub: subNone, now })
  assert(!r.token && /no Claude Code CLI login/.test(r.error), 'both missing -> error carrying the CLI reason')
}
{
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliExpired, readSub: subBlob(NOW - 1000), now })
  assert(!r.token && r.error, 'cli expired + subscription blob expired -> error')
}
{
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliExpired, readSub: () => { throw new Error('safeStorage') }, now })
  assert(!r.token && r.error, 'cli expired + subscription unreadable -> error, no throw')
}
{
  const r = resolveClaudeLaneToken('claude-cli', { readCli: cliExpired, readSub: subBare, now })
  assert(r.token === 'sk-ant-oat01-sub-bare', 'cli expired + bare subscription token -> subscription')
}

// claude-subscription route: unchanged, slot only
{
  const r = resolveClaudeLaneToken('claude-subscription', { readCli: cliOk, readSub: subNone, now })
  assert(!r.token && r.error, 'claude-subscription with empty slot -> error (never borrows the CLI login)')
}

// Spawn path: buildProviderEnv('claude-cli') uses the same order.
{
  const res = buildProviderEnv('claude-cli', {}, { readProviderKey: (p) => (p === 'claude-subscription' ? 'sk-ant-oat01-sub-spawn' : null), readClaudeCliToken: cliExpired })
  assert(!res.error && res.env.ANTHROPIC_API_KEY === 'sk-ant-oat01-sub-spawn', 'buildProviderEnv claude-cli: dead CLI login spawns on the subscription token')
}
{
  const res = buildProviderEnv('claude-cli', {}, { readProviderKey: () => null, readClaudeCliToken: cliExpired })
  assert(res.error && res.error.kind === 'not_ready', 'buildProviderEnv claude-cli: nothing usable -> not_ready')
}

// Banner hint branch
assert(claudeAuthLoginHint('claude-cli', false) === 'cli-terminal', 'hint: claude-cli + no subscription token -> cli-terminal')
assert(claudeAuthLoginHint('claude-cli', true) === null, 'hint: claude-cli + subscription token -> none')
assert(claudeAuthLoginHint('claude-subscription', false) === null, 'hint: claude-subscription -> none')

// Banner text: copy.js is browser source, so the turnError arrow is cut out
// of it and evaluated alone.
{
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
  const src = fs.readFileSync(path.join(root, 'onboarding/public/js/copy.js'), 'utf8')
  const m = /turnError: (\(subtype, detail, hint\) => [\s\S]*?),\n\s*turnErrorDismiss/.exec(src)
  assert(!!m, 'copy.js: turnError(subtype, detail, hint) located')
  if (m) {
    const turnError = (0, eval)(m[1])
    const withHint = turnError('AUTH', 'HTTP 401', 'cli-terminal')
    const noHint = turnError('AUTH', 'HTTP 401', null)
    assert(withHint.includes('or log in again by running `claude` in a terminal'), 'banner: cli-terminal hint names the terminal login')
    assert(!noHint.includes('in a terminal') && noHint.includes('Settings > Model'), 'banner: no hint keeps the original text')
    assert(!turnError('RATE', 'x', 'cli-terminal').includes('terminal'), 'banner: non-AUTH errors unaffected')
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
