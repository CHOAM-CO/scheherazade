#!/usr/bin/env node
// dev-chat-driver.mjs — run the REAL channel-local.mjs with a toy "agent"
// behind it, so the /chat page can be exercised end to end without Electron
// or a claude session: page -> /api/chat/in -> channel HTTP -> MCP
// notification -> THIS driver -> `reply` tool -> outbound queue -> page.
//
// Pair with dev-serve-ui.mjs, SAME sandboxed AGENT_DATA_HOME (the proxy
// discovers the channel from DATA_HOME/local-channel.json, so the two must
// agree):
//   AGENT_DATA_HOME=/tmp/scheherazade-uidev node scripts/dev-serve-ui.mjs
//   AGENT_DATA_HOME=/tmp/scheherazade-uidev node scripts/dev-chat-driver.mjs
//
// The channel is SPAWNED as a child, never import()ed: importing would run
// its module body inside this process and the two would fight over stdio.
// The driver speaks minimal newline-delimited JSON-RPC (the MCP stdio
// framing) directly -- no SDK dependency, so what rides the pipe is visible
// in this file.
//
// Sandbox rule copied from dev-serve-ui.mjs verbatim: the channel writes
// liveness markers and local-channel.json into DATA_HOME. Refuse to point
// that at a live install.

import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const dataHome = process.env.AGENT_DATA_HOME
const realHome = path.join(os.homedir(), 'Documents', 'Scheherazade')
if (!dataHome || path.resolve(dataHome) === path.resolve(realHome)) {
  console.error('refusing to start: set AGENT_DATA_HOME to a scratch dir first')
  console.error(`  e.g. AGENT_DATA_HOME=/tmp/scheherazade-uidev node ${process.argv[1]}`)
  console.error(`  (must not be the live install at ${realHome})`)
  process.exit(1)
}

const child = spawn(process.execPath, [path.join(ROOT, 'channel-local.mjs')], {
  env: { ...process.env, AGENT_NAME: process.env.AGENT_NAME || 'Scheherazade' },
  stdio: ['pipe', 'pipe', 'inherit'],
})

let nextId = 1
function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n')
}

function callTool(name, args) {
  send({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } })
}

let replyCount = 0
function handleMessage(msg) {
  if (msg.method === 'notifications/claude/channel') {
    const content = (msg.params && msg.params.content) || ''
    console.log(`[driver] user said: ${JSON.stringify(content)}`)
    // A user reaction tap: log it and stay silent -- mirrors the real
    // agent's non-obligation (stop-reply-guard exempts [reaction] triggers),
    // and lets the page prove no forced echo follows a tap.
    if (content.startsWith('[reaction]')) return
    // Manual-verification lever for the DM states: a message containing
    // "react" draws an emoji reaction instead of an echo (badge on the USER
    // bubble); "slow" delays the echo 8s so typing dots are watchable.
    replyCount++
    if (/react/i.test(content)) {
      setTimeout(() => { callTool('react', { emoji: '👍' }) }, 400)
      return
    }
    const delay = /slow/i.test(content) ? 8_000 : 400
    setTimeout(() => {
      callTool('reply', { text: `(dev echo #${replyCount}) you said: ${content}` })
    }, delay)
    return
  }
  if (msg.id !== undefined && msg.result !== undefined) {
    // initialize result or tool result -- log compactly, keep going.
    if (msg.result.serverInfo) console.log(`[driver] channel up: ${msg.result.serverInfo.name}`)
  }
}

let buf = ''
child.stdout.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line.trim()) continue
    try { handleMessage(JSON.parse(line)) } catch { console.log(`[channel raw] ${line}`) }
  }
})

child.on('exit', (code) => {
  console.error(`[driver] channel exited (${code})`)
  process.exit(code || 0)
})

send({
  jsonrpc: '2.0',
  id: nextId++,
  method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dev-chat-driver', version: '0' } },
})
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
console.log(`[driver] echo agent ready; DATA_HOME=${dataHome} (watch for local-channel.json)`)
