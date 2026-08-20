// 0.2.4 answer-stream + instruction-surface port: dsh-lane source pins.
//
// The lane is not importable in a test (it binds its ingest server and
// spawns the engine at module scope), so like test-supervisor's env-contract
// pins these assert the load-bearing SOURCE facts. The server half of the
// stream contract (untrimmed append, done-retire, reply-supersede,
// clear-with-thread, never-a-queue-item) is behavior-tested in
// test-local-channel.mjs; what a pin guards here is the lane half working
// against that contract, and the patch rows that resurrect dsh's own
// instruction/skill surfaces.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const src = fs.readFileSync(path.join(ROOT, 'dsh-lane.mjs'), 'utf8')

let passed = 0
let failed = 0
function assert (cond, msg) {
  if (cond) { passed++; console.log(`  ok   ${msg}`) } else { failed++; console.log(`  FAIL ${msg}`) }
}

console.log('1. answer stream (두두두둑) — lane half of the draft contract')
assert(src.includes("postPresence(text.slice(0, 3900), 'stream')"),
  'stream flush posts kind:stream through the same presence path as think')
assert(src.includes("if (lastInboundChannelId !== 'in-app') { streamBuf = ''; return }"),
  'streaming is gated to in-app turns — a Discord turn never paints a local phantom draft')
assert(src.includes("lastInboundChannelId = String((payload.meta || {}).channelId || 'in-app')"),
  'the gate is fed from ingest meta, defaulting to in-app like renderChannelTag does')
assert(src.includes("streamBuf += c.text || c.delta || ''"),
  'text-deltas feed the stream buffer (they were discarded before 0.2.4)')
assert(src.includes("if (streamedThisTurn) postPresence('', 'stream', { done: true })"),
  'turn/end posts done:true so a reply-less (mute) turn still retires the draft')
{
  const turnEnd = src.indexOf("event.type === 'turn/end'")
  const bufClear = src.indexOf('streamBuf = \'\'', turnEnd)
  const donePost = src.indexOf('streamedThisTurn) postPresence', turnEnd)
  assert(turnEnd > -1 && bufClear > -1 && bufClear < donePost,
    'turn/end drops the unposted tail BEFORE the done post — the reply message owns the authoritative text')
}
assert(/const STREAM_FLUSH_AT = \d+/.test(src) && /const STREAM_TURN_CAP = \d+/.test(src),
  'flush threshold and per-turn cap are named constants (runaway turns stay bounded)')
assert(src.includes('body: JSON.stringify(kind ? { label, kind, ...(extra || {}) } : { label })'),
  'postPresence generalizes to kind+extra without changing the think/activity wire shape')

console.log('\n2. instruction-surface port — host skill provider + lane-owned preset')
assert(src.includes('- id: skill-filesystem') && /skill-filesystem[\s\S]{0,1200}disabled: false/.test(src),
  'skill-filesystem re-enabled at host level: the seeded .claude/skills dir becomes a dsh skill root')
assert(/skill-filesystem[\s\S]{0,1200}providerName: app-seeded/.test(src),
  'the provider carries a unique name (README: isolated custom-root providers must not share "filesystem")')
assert(/skill-filesystem[\s\S]{0,1300}includeDefaultRoots: false/.test(src),
  "includeDefaultRoots off — only the app-owned dir, never the user's ~/.dsh or ~/.agents skills")
assert(src.includes("yamlQuote(path.join(MEM, '.claude', 'skills'))"),
  'the skill root is the SAME dir the hash-refresh seeding machinery already writes')
assert(!/- id: agent-instructions[\s\S]{0,400}disabled: false/.test(src) && !/- id: tool-skill/.test(src),
  'NO profile-level agent-instructions/tool-skill rows — the preset already mounts both (double-mount guard)')

console.log('\n3. websearch recovery — web_search comes from the PRESET, so the lane owns a preset')
assert(src.includes("const LANE_PRESET_ID = 'schz-standard'") && src.includes('function ensureLanePreset'),
  'lane authors its own preset (shipped standard minus tool-web) into the user preset root')
assert(src.includes("src.indexOf('- id: tool-web')") && /slice\(0, cut\)/.test(src),
  'the tool-web row (the model-facing web_search) is what gets cut')
assert(/- id: agent-presets[\s\S]{0,1200}default: \$\{LANE_PRESET_ID\}/.test(src),
  'the patch points the preset default at the lane-owned copy (launcher force-overwrites roots, so default is the only lever)')
assert(src.includes('ensureLanePreset() // the patch') || /ensureLanePreset\(\)/.test(src.split('function ensureLanePreset')[0] + src.split('function ensureLanePreset')[1] || ''),
  'ensureLanePreset runs in the patch build path, before the engine boots')
assert(/- id: web\n  #[\s\S]{0,400}disabled: true/.test(src) && /- id: web-search-deepseek\n  disabled: true/.test(src),
  'the web service + DeepSeek search provider are pinned off (no keyed search path can resurrect)')
console.log('\n4. skill catalog race — nudge after session creation')
assert(src.includes('skill catalog nudge') && src.includes('fs.utimesSync(f, now, now)'),
  'lane nudges one SKILL.md mtime after session creation (catalog only renders if discovery beats the first request)')

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
