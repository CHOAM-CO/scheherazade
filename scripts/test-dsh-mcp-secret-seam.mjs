// test-dsh-mcp-secret-seam.mjs — the channel-secret seam on the dsh lane.
//
// Field case (2026-08-21, Mino magi-win): discord setup on the dsh lane died
// in a "DISCORD_BOT_TOKEN not set" FATAL loop. Root cause: the dsh harness
// spawns stdio MCP children with a scrubbed parent env (/KEY|PASSWORD|SECRET|
// TOKEN/i dropped), so main.cjs's spawn-time env injection — sufficient on
// the claude lanes, which forward the full env — never reached channel.mjs.
// Fix: dsh-lane.mjs emits `!!js process.env.<NAME>` expression rows into the
// patch's mcp-client env block. The engine process (which holds the secrets)
// evaluates them at load; the patch file on disk carries only the reference
// string; bash/pwsh tool children stay scrubbed.
//
// This test pins BOTH sides of the seam:
//   A. our emitter (dsh-lane.mjs source anchors),
//   B. the upstream facts the fix relies on (scrub pattern, env merge order,
//      !!js dialect) — so a dsh version bump that moves the seam fails HERE
//      instead of as a silent field FATAL loop.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

let passed = 0
let failed = 0
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok   ${name}`) }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`) }
}

// ── A. our emitter ─────────────────────────────────────────────────────────
const lane = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')
// anchor to the passthrough block, not the whole file (source-grep discipline)
const blockStart = lane.indexOf('CHANNEL-SECRET SEAM')
check('dsh-lane carries the channel-secret seam block', blockStart !== -1)
const block = lane.slice(blockStart, blockStart + 2500)
for (const name of ['DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']) {
  check(`passthrough list names ${name}`, block.includes(`'${name}'`))
}
check('emits an expression REFERENCE, never a value',
  block.includes('!!js process.env.${k}') && !block.includes('yamlQuote(process.env'))

// ── B. upstream facts the fix relies on ────────────────────────────────────
// B1. the scrub really drops these names (why passthrough must exist at all)
const sub = fs.readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-subprocess', 'lib', 'index.js'), 'utf8')
const patMatch = sub.match(/SENSITIVE_ENV_PATTERN\s*=\s*\/(.+?)\/(\w*)/)
check('dsh-subprocess still defines SENSITIVE_ENV_PATTERN', !!patMatch)
if (patMatch) {
  const pat = new RegExp(patMatch[1], patMatch[2])
  check('scrub still drops DISCORD_BOT_TOKEN (fix still needed)', pat.test('DISCORD_BOT_TOKEN'))
  check('scrub does NOT drop HOME_CHANNEL_ID (rides ambient env)', !pat.test('HOME_CHANNEL_ID'))
}

// B2. mcp-client still merges declared env ON TOP of the scrub
const mcp = fs.readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'lib', 'index.js'), 'utf8')
check('mcp-client merges config env after the scrub',
  /\.\.\.scrubbedParentEnv\(\),\s*\.\.\.extra/.test(mcp))

// B3. the patch dialect still parses !!js scalars into expression nodes,
// and the loader still evaluates them (interpolate)
const yaml = require('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar', resolve: () => true,
  construct: (d) => ({ __jsExpr: d }), represent: (d) => d['__jsExpr'],
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)
const parsed = yaml.load('env:\n  DISCORD_BOT_TOKEN: !!js process.env.DISCORD_BOT_TOKEN', { schema })
check('!!js scalar parses to an expression node',
  parsed && parsed.env && parsed.env.DISCORD_BOT_TOKEN
    && parsed.env.DISCORD_BOT_TOKEN.__jsExpr === 'process.env.DISCORD_BOT_TOKEN')
const appBoot = fs.readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js'), 'utf8')
check('app-boot patch dialect registers the !!js tag', appBoot.includes("tag:yaml.org,2002:js"))
const loader = fs.readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'cordis-plugin-loader', 'lib', 'index.js'), 'utf8')
check('loader still evaluates __jsExpr nodes', loader.includes('__jsExpr') && loader.includes('function interpolate'))

// B4. the tool-subprocess runtime still scrubs (the reason we must NOT fix
// this by renaming tokens to scrub-surviving names)
const local = fs.readFileSync(path.join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'), 'utf8')
check('bash/pwsh tool children still get the scrubbed env', local.includes('scrubbedParentEnv'))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
