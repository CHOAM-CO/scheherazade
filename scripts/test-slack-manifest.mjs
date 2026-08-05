#!/usr/bin/env node
// test-slack-manifest.mjs — the Slack app manifest ships in TWO places:
// the canonical file (slack-app-manifest.yaml, Mino's masked production
// manifest, 2026-08-05) and the fenced yaml block inside messenger-connect
// SKILL.md that the agent hands to users verbatim. Retyping is drift
// (journal_compression.md:199 — same lesson, same fix): this test holds
// them byte-identical and pins the events/scopes the app's own code paths
// die without.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const skillDir = path.join(root, 'onboarding', 'templates', 'skills', 'messenger-connect')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const yamlFile = readFileSync(path.join(skillDir, 'slack-app-manifest.yaml'), 'utf8')
const skill = readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')

console.log('1. single source: SKILL.md fenced block == canonical yaml below its marker')
// Canonical content = everything after the "# --- manifest ---" marker line.
const marker = '# --- manifest ---\n'
const mIdx = yamlFile.indexOf(marker)
assert(mIdx !== -1, 'canonical yaml carries the "# --- manifest ---" marker')
const canonical = yamlFile.slice(mIdx + marker.length).trim()
// SKILL.md: the yaml fence that contains display_information.
const fences = [...skill.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1].trim())
const inSkill = fences.find((f) => f.startsWith('display_information:'))
assert(Boolean(inSkill), 'SKILL.md carries exactly one display_information yaml fence')
assert(fences.filter((f) => f.startsWith('display_information:')).length === 1, 'no second manifest fence to drift')
assert(inSkill === canonical, 'fenced block is byte-identical to the canonical yaml (after trim)')

console.log('\n2. masking held (name/description/display_name only — no source identity leaks)')
for (const leak of ['Cadence', 'CTO']) {
  assert(!yamlFile.includes(leak) && !skill.includes(leak), `"${leak}" appears nowhere`)
}

console.log('\n3. the events/scopes this app\'s code paths die without')
// channel-slack.mjs: home-channel mode consumes plain `message` events;
// DM-default consumes message.im; connect UI needs the read pair; socket
// mode is the transport. These lines going missing = silent channel.
const required = [
  'socket_mode_enabled: true',
  '- message.im',
  '- message.channels',
  '- message.groups',
  '- chat:write',
  '- channels:read',
  '- groups:read',
  '- channels:history',
  '- groups:history',
  '- im:history',
  '- im:read',
  '- im:write',
  '- users:read',
  '- files:write',
]
for (const line of required) {
  assert(canonical.includes(line), `manifest carries "${line}"`)
}
// The deliberate deviation from Mino's original, on record: bot_events must
// include the two channel-message events (his day-work manifest has only
// app_mention + message.im there, which makes home-channel mode mention-only).
const botEvents = /bot_events:\n([\s\S]*?)\n  [a-z]/.exec(canonical.replace(/\r/g, ''))
assert(botEvents && botEvents[1].includes('message.channels') && botEvents[1].includes('message.groups'),
  'bot_events (not just user_events) carry message.channels + message.groups')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
