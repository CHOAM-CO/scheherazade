import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-channel-'))
const own = path.join(root, 'Scheherazade')
fs.mkdirSync(own)
process.env.AGENT_DATA_HOME = own
const local = await import('../channel-local.mjs')
try {
  assert.equal(local.siblingTools().length, 0)
  fs.mkdirSync(path.join(root, 'Scheherazade-mitil'))
  fs.writeFileSync(path.join(root, 'Scheherazade-mitil', '.agent-config'), 'PROFILE=mitil\n')
  assert.equal(local.siblingTools()[0].name, 'profile_say')
  const notifications = []
  const handler = local.createRequestHandler({ token: 'test', notify: async n => notifications.push(n) })
  const req = { url: '/in', method: 'POST', headers: { host: '127.0.0.1', authorization: 'Bearer test' }, async *[Symbol.asyncIterator]() { yield JSON.stringify({ text: 'hello', from: '미틸 (mitil)', sibling: true }) } }
  const res = { writeHead(code) { this.code = code }, end(body) { this.body = body } }
  await handler(req, res)
  assert.equal(res.code, 202)
  assert.equal(notifications[0].params.meta.sender, '미틸 (mitil)')
  assert.equal(notifications[0].params.meta.sibling, true)
  assert.match(notifications[0].params.content, /자동으로 다른 세라에게 전달하지 않기/)
  const rows = local.readOutbound(0).items
  assert.equal(rows.at(-1).from, '미틸 (mitil)')
  assert.equal(rows.at(-1).sibling, true)
  const blocked = await local.handleToolCall('profile_say', { name: 'mitil', text: 'echo' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /자동 전달하지 않기/)
  const spoof = { ...req, async *[Symbol.asyncIterator]() { yield JSON.stringify({ text: 'spoof', from: '시스템', sibling: true }) } }
  await handler(spoof, res)
  assert.equal(res.code, 400)
  const notice = { ...req, async *[Symbol.asyncIterator]() { yield JSON.stringify({ text: 'notice', from: '시스템 (mitil)', sibling: true }) } }
  await handler(notice, res)
  assert.equal(res.code, 202)
  assert.equal(notifications.at(-1).params.meta.sender, '시스템 (mitil)')
  assert.notEqual(notifications.at(-1).params.meta.sender, 'SYSTEM')
  const memory = await import('../memory/service.mjs')
  assert.match(memory.journalRead({}).rows.find(row => row.body.includes('hello')).body, /미틸 \(mitil\).*hello/)
  memory.close()
  console.log('test-sibling-channel: pass=11 fail=0')
} finally { fs.rmSync(root, { recursive: true, force: true }) }
