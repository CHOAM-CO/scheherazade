// test-agent-usage-route.mjs -- GET /api/agent/usage: own per-boot token, exempt
// from the onboard-token gate. Also pins the "Token budget" prompt section and
// the usage-budget skill template.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-usage-'))
process.env.HOME = path.join(tmp, 'home'); fs.mkdirSync(process.env.HOME, { recursive: true })
process.env.AGENT_DATA_HOME = path.join(tmp, 'data'); fs.mkdirSync(process.env.AGENT_DATA_HOME, { recursive: true })
process.env.SCHEHERAZADE_MEMORY_DB = path.join(tmp, 'memory.db')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createOnboardingServer } = require_('./onboarding/http-server.cjs')

let ok = 0, bad = 0
const check = (c, m) => { c ? ok++ : bad++; console.log(`  ${c ? 'ok' : 'FAIL'}: ${m}`) }

const { server } = await createOnboardingServer({ onOnboardingComplete: () => {} })
try {
  const epFile = path.join(process.env.AGENT_DATA_HOME, '.usage-endpoint.json')
  check(fs.existsSync(epFile), 'endpoint file written')
  check((fs.statSync(epFile).mode & 0o777) === 0o600, 'endpoint file is 0600')
  const ep = JSON.parse(fs.readFileSync(epFile, 'utf8'))
  check(/\/api\/agent\/usage$/.test(ep.url) && ep.token.length === 64, 'endpoint has url + 32-byte token')
  let r = await fetch(ep.url)
  check(r.status === 403, 'no token -> 403')
  r = await fetch(ep.url, { headers: { Authorization: 'Bearer ' + 'x'.repeat(64) } })
  check(r.status === 403, 'wrong token -> 403')
  r = await fetch(ep.url, { headers: { Authorization: `Bearer ${ep.token}` } })
  const body = await r.json()
  check(r.status === 200 && body.ok === true, 'valid token -> 200')
  check(['claude', 'codex', 'ollama'].every((k) => k in body) && typeof body.at === 'string', 'body has claude/codex/ollama/at')
  check(!JSON.stringify(body).includes(ep.token), 'token not echoed')
} finally { server.close() }

const prompt = fs.readFileSync(path.join(ROOT, 'onboarding/templates/agent-system-prompt.md'), 'utf8')
check(/## Token budget/.test(prompt) && /usage-budget/.test(prompt), 'prompt has Token budget section')
check(fs.existsSync(path.join(ROOT, 'onboarding/templates/skills/usage-budget/SKILL.md')), 'usage-budget skill template exists')
console.log(`\n${ok} passed, ${bad} failed`)
process.exit(bad ? 1 : 0)
