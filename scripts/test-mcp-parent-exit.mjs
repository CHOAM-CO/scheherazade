#!/usr/bin/env node
// test-mcp-parent-exit.mjs — pins the parent-death (stdin EOF) self-exit of the
// memory MCP stdio server (memory/server.mjs).
// Run: node scripts/test-mcp-parent-exit.mjs
//
// WHY: an MCP stdio server's stdin is its lifeline to the parent (claude). The
// MCP SDK transport reads stdin but never exits when it ends, and a server
// holding a live handle (SQLite here, the Discord gateway in channel.mjs) keeps
// the event loop alive forever — so a dead parent ORPHANS it. On Windows there
// are no POSIX process groups, so the app's tree-kill can't reach a grandchild;
// every recycle/quit stranded these. Fix (2026-08-18): a stdin end/close
// handler that closes its resource and exits 0, with a safety timeout.
//
// This mirrors test-local-channel.mjs section 9 (which pins the same guard for
// channel-local.mjs). channel.mjs's equivalent handler is NOT covered here — it
// requires a real Discord login to reach the orphan state, which is not
// hermetic; its Windows behavior is verified live on magi-win instead.
//
// Mirrors the assert()/pass/fail convention of the other scripts.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++; console.log(`  ok   ${label}`) }
  else { fail++; console.log(`  FAIL ${label}`) }
}

console.log('memory MCP server: parent death (stdin EOF) exits the process cleanly')
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-mcp-parent-exit-'))
  const dbPath = path.join(tmp, 'memory.db')
  const child = spawn(process.execPath, [path.join(ROOT, 'memory', 'server.mjs')], {
    env: { ...process.env, AGENT_NAME: 'parent-exit-test', SCHEHERAZADE_MEMORY_DB: dbPath },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Wait for boot ("MCP server up" on stderr) so the stdin transport is live.
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d.toString() })
  const bootDeadline = Date.now() + 10_000
  while (!stderr.includes('MCP server up') && Date.now() < bootDeadline) {
    await new Promise((r) => setTimeout(r, 100))
  }
  assert(stderr.includes('MCP server up'), 'child boots the MCP stdio server')

  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  child.stdin.end() // parent death, as the child sees it
  const code = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 5_000)),
  ])
  assert(code === 0, `stdin EOF exits the process cleanly (got ${code})`)
  if (code === 'TIMEOUT') child.kill('SIGKILL')
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
