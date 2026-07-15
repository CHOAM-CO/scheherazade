#!/usr/bin/env node
// post-bash-permission-translator.mjs — PostToolUse hook, Bash tool only.
//
// WHY THIS HOOK EXISTS (춘식3 permission proposal P1, 2026-07-15; adopted by
// Idea/PO same day): when a command dies on a macOS permission wall the agent
// tends to go silent and diagnose (worst observed: 16 minutes of "됐어?
// 대답 빨리" while the agent quietly collected receipts). The failure is
// perfectly translatable the moment it happens — command + stderr pattern
// names the wall, the wall names the fix. This hook does that translation
// and hands the agent an explicit "tell the user NOW" instruction as
// additionalContext. The permission itself still needs a human toggle (P1
// kills the silence, not the wall — his doc's own distinction).
//
// ADVISORY, FAIL-OPEN: this is a translation layer, not a gate. Any internal
// error exits 0 silently (pack convention: only the rumination gate is
// blocking/fail-loud). It never denies the tool call — Bash already ran.
//
// Pattern table source: 춘식3's proposal §P1 (command+stderr combos, his
// direct receipts 2026-07-15). rc alone is never enough — command + stderr
// text is the discriminator. TCC vs SIP vs sudo separation is his; keeping
// it verbatim because collapsing them misroutes the user ("어디서 켜야
// 하는데?" has three different answers).

import { readFileSync } from 'node:fs'

try {
  let raw = ''
  try {
    raw = readFileSync('/dev/stdin', 'utf8').trim()
  } catch {
    process.exit(0)
  }
  if (!raw) process.exit(0)

  let input
  try {
    input = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  if ((input.tool_name || '') !== 'Bash') process.exit(0)

  const command = String(input.tool_input?.command || '')
  // PostToolUse payloads carry the tool's result; be liberal in what we
  // scan — string or MCP-style content array, stdout+stderr merged.
  const resp = input.tool_response
  let output = ''
  if (typeof resp === 'string') output = resp
  else if (resp && typeof resp === 'object') {
    if (typeof resp.output === 'string') output += resp.output
    if (typeof resp.stdout === 'string') output += `\n${resp.stdout}`
    if (typeof resp.stderr === 'string') output += `\n${resp.stderr}`
    if (Array.isArray(resp.content)) output += '\n' + resp.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  }
  if (!command && !output) process.exit(0)

  const SETTINGS_DEEPLINK = 'x-apple.systempreferences:com.apple.preference.security'

  // Each rule: command pattern + output pattern -> wall class + user-facing fix.
  const RULES = [
    {
      cmd: /osascript|AppleScript/i,
      out: /-1743|-1712|Not authorized to send Apple events|AppleEvent/i,
      wall: 'Automation (자동화) TCC',
      layer: 'TCC',
      fix: `시스템 설정 > 개인정보 보호 및 보안 > 자동화에서 이 앱의 대상 앱 제어를 허용 (딥링크: ${SETTINGS_DEEPLINK}?Privacy_Automation)`,
      caveat: '-1712는 타임아웃이라 권한 거부 확정은 아님 (대상 앱 미응답 가능성도 있음) — 사용자에게 그대로 말할 것.',
    },
    {
      cmd: /screencapture/i,
      out: /could not create image/i,
      wall: 'Screen Recording (화면 기록) TCC',
      layer: 'TCC',
      fix: `시스템 설정 > 개인정보 보호 및 보안 > 화면 및 시스템 오디오 기록에서 이 앱 허용 (딥링크: ${SETTINGS_DEEPLINK}?Privacy_ScreenCapture)`,
      caveat: null,
    },
    {
      cmd: /TIOCSTI|ioctl/i,
      out: /EPERM|Operation not permitted/i,
      wall: 'SIP (키스트록 주입 차단)',
      layer: 'SIP — TCC 아님',
      fix: 'TCC 토글로 안 풀림. 대안: CGEventPost 방식 입력 주입(손쉬운 사용 권한 필요) 또는 이 접근 포기. SIP 비활성화는 권장 안 함.',
      caveat: '사용자가 "어디서 켜?"라고 물으면 "앱 권한 밖"이라고 답해야 함.',
    },
    {
      cmd: /sudo/i,
      out: /password is required|a terminal is required/i,
      wall: 'sudo 인증',
      layer: 'sudo — TCC 아님',
      fix: '비밀번호 없이는 실행 불가. 사용자가 직접 실행하거나, 관리자가 sudoers 화이트리스트를 설정해야 함.',
      caveat: '비밀번호를 채팅/stdin으로 받는 우회는 금지 (transcript 영구 노출).',
    },
    {
      cmd: /Library\/(Mail|Safari|Messages|Calendars)/i,
      out: /Operation not permitted|EPERM/i,
      wall: 'Full Disk Access (전체 디스크 접근) TCC',
      layer: 'TCC',
      fix: `시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근에서 이 앱 허용 (딥링크: ${SETTINGS_DEEPLINK}?Privacy_AllFiles)`,
      caveat: null,
    },
  ]

  const hit = RULES.find((r) => r.cmd.test(command) && r.out.test(output))
  if (!hit) process.exit(0)

  const lines = [
    `[권한 벽 감지] 방금 Bash 실패는 ${hit.wall} 때문일 가능성이 높다 (계층: ${hit.layer}).`,
    `지금 바로 사용자에게 reply로 알려라 — 조용히 진단을 계속하지 마라. 침묵이 최악의 응답이다.`,
    `사용자에게 전달할 내용: (1) 어떤 작업이 막혔는지 한 줄, (2) 필요한 권한: ${hit.wall}, (3) 해결: ${hit.fix}`,
  ]
  if (hit.caveat) lines.push(`주의: ${hit.caveat}`)
  lines.push('알린 뒤에 대안 경로가 있으면 시도하고, 없으면 사용자 토글을 기다려라.')

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: lines.join('\n'),
      },
    }),
  )
  process.exit(0)
} catch {
  process.exit(0)
}
