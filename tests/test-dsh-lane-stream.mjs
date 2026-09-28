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
assert(src.includes("const piece = c.text || c.delta || ''") && src.includes('streamBuf += piece'),
  'text-deltas feed the stream buffer (they were discarded before 0.2.4)')
assert(src.includes('turnText += piece'),
  'the full turn text accumulates separately, for mute-promotion')
assert(/lastInboundChannelId === 'in-app' && turnText\.trim\(\)/.test(src) && src.includes('promoteTurnText(turnText.trim())'),
  'an in-app mute turn is PROMOTED (composed text delivered as the message), not nudged')
assert(src.includes('function promoteTurnText') && /promote: true/.test(src) && src.includes('sendMuteNudge()'),
  'promotion verifies the POST and falls back to the nudge on failure')
assert(src.includes("DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'danger-full-access'"),
  "approval gate off by default (product bypass contract; live catch: websearch turn hung forever on approval/asked)")
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
// CHANGED 2026-09-28 (memory mark): this pin used to match the bare
// `body: JSON.stringify(kind ? ...)` line. postPresence now branches on the
// memory kind before the body, so the substring moved without the wire shape
// it pins moving an inch — think/activity still send exactly this payload.
// Same intent, matched against the new line; the body-less memory kind is
// pinned separately in 5b.
assert(src.includes('JSON.stringify(kind ? { label, kind, ...(extra || {}) } : { label })') &&
  /body: memoryRead \? undefined : JSON\.stringify\(kind \? \{ label, kind/.test(src),
  'postPresence generalizes to kind+extra without changing the think/activity wire shape')

console.log('\n1b. reply-arg streaming — the answer rides the reply TOOL, not body text')
assert(src.includes("c.type === 'tool-call-delta' && /__reply\\$/.test(String(c.name || ''))") ||
       /tool-call-delta.*__reply/.test(src),
  'tool-call-delta chunks for reply-class tools feed the stream (live catch: body text-deltas stay empty on real turns)')
assert(src.includes('function extractTextField'),
  'the text field is extracted incrementally from the growing reply-args JSON')
{
  // Behavior-test the extractor by evaluating it in isolation.
  const m = src.match(/function extractTextField[\s\S]*?\n  \}/)
  assert(!!m, 'extractTextField source is liftable for behavior tests')
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${m[0]}; return extractTextField`)()
  assert(fn('{"channelId":"in-app","text":"안녕 ') === '안녕 ',
    'partial value extracts as-is, untrimmed')
  assert(fn('{"text":"a\\nb\\"c"') === 'a\nb"c',
    'escapes decode (newline, quote)')
  assert(fn('{"text":"x\\') === 'x',
    'a trailing backslash (partial escape) stops the scan instead of corrupting output')
  assert(fn('{"text":"x\\ud8') === 'x',
    'a partial \\u escape (fewer than 4 hex digits) is held back until more delta arrives')
  assert(fn('{"text":"x\\ud83d') === 'x\ud83d' && fn('{"text":"x\\ud83d\\ude00') === 'x😀',
    'surrogate halves decode as they complete — append semantics reunite an emoji split across flushes')
  assert(fn('{"text":"done"}') === 'done',
    'a closed string extracts completely')
  assert(fn('{"channelId":"in-app"') === null,
    'no text key yet -> null (nothing streamed)')
}
// 0.2.17 (Mino 08-27): the wipe is UNCONDITIONAL at tool/call — step
// narration between tool calls is ephemeral status, not draft content. The
// reply-class case (no stale-tail repaint beside the delivered reply) is a
// subset of the same wipe, so both behaviors ride one assertion: the wipe
// must sit in the tool/call handler AFTER the sawReplyThisTurn mark and
// OUTSIDE any isReplyClassTool guard.
assert(/if \(isReplyClassTool\(d\.name\)\) sawReplyThisTurn = true[\s\S]{0,1600}streamBuf = ''[\s\S]{0,200}done: true/.test(src),
  'every tool/call retires the draft immediately (step narration is ephemeral; covers the reply-class stale-tail case too)')
assert(src.includes('replyArgStreams.clear()'),
  'per-call arg buffers reset at turn end')

console.log('\n1c. draft purity — reply args own the draft once they start')
assert(src.includes('let replyArgStarted = false'),
  'turn-scoped replyArgStarted flag exists (glm live catch: body-text plan narration glued to the answer)')
assert(/if \(!replyArgStarted\) \{\s*\n\s*replyArgStarted = true\s*\n\s*if \(streamTimer\)[\s\S]{0,200}done: true/.test(src),
  'first extracted reply-arg text wipes the body-text preamble draft (done-post) before streaming the answer')
assert(src.includes("if (!replyArgStarted) streamBuf += piece"),
  'body text-deltas stop feeding the draft after reply args start')
{
  const i = src.indexOf("if (!replyArgStarted) streamBuf += piece")
  const j = src.indexOf('turnText += piece', i)
  assert(i > -1 && j > -1 && j - i < 200,
    'turnText still accumulates suppressed body text (mute promotion wants the full composed text)')
}
assert(/replyArgStreams\.clear\(\)\s*\n\s*replyArgStarted = false/.test(src),
  'replyArgStarted resets with the other per-turn stream state at turn/end')

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

console.log('\n5. background-subagent roster (0.2.15) — lane half of the bg contract')
assert(src.includes("BG_STARTED_RE = /^started (?:background subagent job|subagent) (\\S+)/"),
  'launch detection parses dsh-tool-subagent\'s own render text (background job AND continuable forms)')
assert(src.includes("d.name === 'subagent' && d.callId") && src.includes('pendingSubagentCalls.set(d.callId'),
  'a subagent tool/call parks its display label under its callId until the result names the id')
assert(src.includes("postPresence(bgLabel || 'background subagent', 'bg', { id: m[1] })"),
  'a background launch posts kind:bg with the engine-issued id')
assert(src.includes("src.kind === 'subagent-settled' && src.senderSessionId") &&
  src.includes("postPresence('', 'bg', { id: String(src.senderSessionId), done: true })"),
  'the settlement notice (source.kind subagent-settled) retires the child by senderSessionId')
assert(src.includes("d.name === 'job_kill' && argsForLabel.jobId"),
  'job_kill retires its target id immediately (one-shot background jobs get no settlement notice)')

console.log('\n5b. memory mark (2026-09-28) — the lane half, kept in step with the hook')
// The claude lane reports a memory read from the PreToolUse hook; dsh has no
// shell hooks, so the lane reports it from its own tool/call events. Two call
// sites, ONE protocol (POST /memory-read, no body) and one list of tool names
// that they cannot share (dsh-lane cannot import a hook script), so the list is
// pinned against the hook's copy here rather than trusted.
assert(src.includes("postPresence('', 'memory-read')"),
  'a memory read is reported from the tool/call branch (it builds no label, so this is the only post)')
assert(/const memoryRead = kind === 'memory-read'/.test(src) &&
  /\$\{memoryRead \? 'memory-read' : 'activity'\}/.test(src),
  'the same presence path routes it to /memory-read instead of /activity')
assert(/body: memoryRead \? undefined : JSON\.stringify/.test(src),
  'the memory post carries NO body (the call is the signal) — every other kind keeps its label payload')
{
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'pre-tool-activity.mjs'), 'utf8')
  const namesIn = (text, start, end) =>
    [...text.slice(text.indexOf(start), text.indexOf(end)).matchAll(/'(mcp__memory__[a-z_]+)'/g)]
      .map((m) => m[1]).sort()
  const lane = namesIn(src, 'const MEMORY_READ_TOOLS', 'function activityLabelFor')
  const hookSide = namesIn(hook, 'const MEMORY_READ_TOOLS', 'const memoryRead')
  assert(lane.length === 3 && JSON.stringify(lane) === JSON.stringify(hookSide),
    `both lanes name the same three read-class tools (${lane.join(', ')} vs ${hookSide.join(', ')})`)
  assert(!lane.some((n) => /write|confirm|delete|_events$/.test(n)),
    'the WRITE-class memory tools stay out of both lists — changing what it knows is not "this came out of memory"')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
