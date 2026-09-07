#!/usr/bin/env node
// test-permission-translator.mjs -- post-bash-permission-translator.mjs's
// promises, attacked with fixture PostToolUse payloads (no live anything).
//
// The promises:
//   1. Each of 춘식3's five wall classes translates: command+stderr combo ->
//      wall name + fix text (deep link where TCC) in additionalContext, with
//      an explicit tell-the-user-NOW instruction.
//   2. TCC vs SIP vs sudo separation survives: SIP/sudo hits must SAY they
//      are not TCC-toggleable (the "어디서 켜야 하는데?" misroute guard).
//   3. rc/exit-code alone NEVER fires -- command + stderr text is the
//      discriminator (his doc: "rc=1만으로는 분류 불가").
//   4. Non-Bash tools, clean output, and garbage stdin are all silent
//      no-ops (advisory fail-open; only the rumination gate may block).
//
// Run: node scripts/test-permission-translator.mjs

import { spawnSync } from 'node:child_process'
import path from 'node:path'

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'post-bash-permission-translator.mjs')

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed++ } else { failed++; console.error(`FAIL: ${name}${detail ? ` -- ${detail}` : ''}`) }
}

function run(payload) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', timeout: 15000 })
  let ctx = null
  if (r.stdout && r.stdout.trim()) {
    try { ctx = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? null } catch { ctx = `UNPARSEABLE: ${r.stdout.slice(0, 80)}` }
  }
  return { code: r.status, ctx }
}

const bash = (command, out) => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { output: out } })

// 1. Automation TCC (osascript, -1712 timeout shape)
{
  const { code, ctx } = run(bash('osascript -e \'tell application "iTerm" to activate\'', 'execution error: AppleEvent 시간이 초과되었습니다. (-1712)'))
  check('automation: fires', code === 0 && !!ctx)
  check('automation: names the wall', ctx?.includes('Automation'))
  check('automation: deep link present', ctx?.includes('Privacy_Automation'))
  check('automation: -1712 caveat kept (timeout != denial)', ctx?.includes('타임아웃'))
  check('automation: tell-user-now instruction', ctx?.includes('reply'))
}

// 2. Screen Recording TCC
{
  const { ctx } = run(bash('screencapture -x /tmp/s.png', 'screencapture: could not create image from display'))
  check('screen: fires with ScreenCapture deep link', !!ctx && ctx.includes('Privacy_ScreenCapture'))
}

// 3. SIP (TIOCSTI) -- must say NOT TCC
{
  const { ctx } = run(bash('python3 -c "fcntl.ioctl(0, termios.TIOCSTI, c)"', 'PermissionError: [Errno 1] Operation not permitted'))
  check('sip: fires', !!ctx)
  check('sip: says not-TCC', ctx?.includes('TCC 아님'))
  check('sip: no settings deep link pretense', !ctx?.includes('Privacy_'))
}

// 4. sudo auth -- must say NOT TCC + forbid stdin-password workaround
{
  const { ctx } = run(bash('sudo -n systemsetup -setremotelogin on', 'sudo: a password is required'))
  check('sudo: fires and says not-TCC', !!ctx && ctx.includes('TCC 아님'))
  check('sudo: transcript-exposure guard kept', ctx?.includes('금지'))
}

// 5. Full Disk Access
{
  const { ctx } = run(bash('ls ~/Library/Mail/V10', 'ls: Operation not permitted'))
  check('fda: fires with AllFiles deep link', !!ctx && ctx.includes('Privacy_AllFiles'))
}

// 6. rc-only failure text does NOT fire (no stderr discriminator)
{
  const { code, ctx } = run(bash('osascript -e something', 'command failed with exit code 1'))
  check('rc-only: silent', code === 0 && ctx === null)
}

// 7. Matching stderr under the WRONG command does not fire
{
  const { ctx } = run(bash('echo hello', 'could not create image from display'))
  check('wrong-command: silent', ctx === null)
}

// 8. Clean success output: silent
{
  const { code, ctx } = run(bash('ls -la', 'total 48\ndrwxr-xr-x ...'))
  check('clean: silent no-op', code === 0 && ctx === null)
}

// 9. Non-Bash tool: silent
{
  const { code, ctx } = run({ tool_name: 'Read', tool_input: {}, tool_response: 'could not create image from display' })
  check('non-bash: silent', code === 0 && ctx === null)
}

// 10. Garbage stdin: fail-open silent
{
  const { code, ctx } = run('{{{not json')
  check('garbage stdin: exit 0 silent', code === 0 && ctx === null)
  const { code: c2 } = run('')
  check('empty stdin: exit 0 silent', c2 === 0)
}

// 11. content-array response shape (MCP-style) still scanned
{
  const { ctx } = run({ tool_name: 'Bash', tool_input: { command: 'screencapture -x a.png' }, tool_response: { content: [{ type: 'text', text: 'could not create image from display' }] } })
  check('content-array shape: fires', !!ctx && ctx.includes('Privacy_ScreenCapture'))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
