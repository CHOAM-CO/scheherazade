import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import siblings from '../sibling-profiles.cjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sibling-channel-'))
const own = path.join(root, 'Scheherazade')
const peer = path.join(root, 'Scheherazade-mitil')
fs.mkdirSync(own)
fs.writeFileSync(path.join(own, '.agent-config'), 'DISPLAY_NAME=Original\n')
process.env.AGENT_DATA_HOME = own
const local = await import('../channel-local.mjs')
const { createInboundNotifier } = await import('../channel-runtime.mjs')
const servers = []
try {
  assert.equal(local.siblingTools().length, 0)
  fs.mkdirSync(peer)
  fs.writeFileSync(path.join(peer, '.agent-config'), 'PROFILE=mitil\nDISPLAY_NAME=미틸\n')
  assert.equal(local.siblingTools()[0].name, 'profile_say')
  const notifications = []
  const peerNotifications = []
  async function listen(dataHome, received) {
    const server = http.createServer(local.createRequestHandler({ dataHome, token: 'test', notify: async n => received.push(n) }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    servers.push(server)
    const port = server.address().port
    fs.writeFileSync(path.join(dataHome, 'local-channel.json'), JSON.stringify({ port, token: 'test' }))
    return async payload => {
      const response = await fetch(`http://127.0.0.1:${port}/in`, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      return { status: response.status, body: await response.json() }
    }
  }
  const inbound = await listen(own, notifications)
  const peerInbound = await listen(peer, peerNotifications)

  // A -> B (hop 1), B -> A (hop 2), A -> B (hop 3) is rejected.
  await siblings.say(own, 'mitil', 'first')
  assert.equal(peerNotifications.at(-1).params.meta.hop, 1)
  await siblings.say(peer, 'default', 'hello')
  assert.equal(notifications.at(-1).params.meta.sender, '미틸 (mitil)')
  assert.equal(notifications.at(-1).params.meta.sibling, true)
  assert.equal(notifications.at(-1).params.meta.hop, 2)
  assert.match(notifications.at(-1).params.content, /자동으로 다른 세라에게 전달하지 않기/)
  const rows = local.readOutbound(0).items
  assert.equal(rows.at(-1).from, '미틸 (mitil)')
  assert.equal(rows.at(-1).sibling, true)
  const beforeRejection = peerNotifications.length
  const blocked = await local.handleToolCall('profile_say', { name: 'mitil', text: 'echo' })
  assert.equal(blocked.isError, true)
  assert.equal(blocked.content[0].text, '대화가 길어져서 여기서 끊어. 사람이 이어 줘')
  assert.equal(peerNotifications.length, beforeRejection)
  // Receiver drops the sender's receipt on a loop rejection.
  assert.equal(siblings.nextHop(peer, 'default'), 1)

  // A queued local human message resets the receipt, not a global turn flag.
  assert.equal((await inbound({ text: 'human asks a fresh question' })).status, 202)
  const fresh = await local.handleToolCall('profile_say', { name: 'mitil', text: 'new conversation' })
  assert.equal(fresh.isError, undefined)
  assert.equal(peerNotifications.at(-1).params.meta.hop, 1)

  // A platform notification is not a sibling receipt or a local-human reset.
  await siblings.say(peer, 'default', 'platform test')
  assert.equal(siblings.nextHop(own, 'mitil'), 3)
  const platformNotifications = []
  const notifyDiscord = createInboundNotifier({ dataHome: own, surface: 'discord', mcpNotify: async params => platformNotifications.push(params) })
  await notifyDiscord({ content: 'a Discord user', meta: { source: 'discord', sender: 'human', channelId: '123', authorId: '456' } })
  assert.equal(platformNotifications.length, 1)
  assert.equal(platformNotifications[0].meta.sibling, undefined)
  assert.equal(siblings.nextHop(own, 'mitil'), 3)

  // Forged high hops never deliver and clear only that sender's receipt.
  const beforeForged = notifications.length
  const forged = await inbound({ text: 'forged', from: '미틸 (mitil)', sibling: true, hop: 999 })
  assert.equal(forged.status, 409)
  assert.equal(forged.body.code, 'sibling_loop')
  assert.equal(notifications.length, beforeForged)
  assert.equal(siblings.nextHop(own, 'mitil'), 1)
  for (const hop of [undefined, 0, -1, 1.5, '2', null]) {
    assert.equal((await inbound({ text: 'invalid hop', from: '미틸 (mitil)', sibling: true, hop })).status, 400)
  }
  const spoof = await inbound({ text: 'spoof', from: '시스템', sibling: true, hop: 1 })
  assert.equal(spoof.status, 400)
  const notice = await inbound({ text: 'notice', from: '시스템 (mitil)', sibling: true, hop: 1 })
  assert.equal(notice.status, 202)
  assert.equal(notifications.at(-1).params.meta.sender, '시스템 (mitil)')
  assert.notEqual(notifications.at(-1).params.meta.sender, 'SYSTEM')

  // The exact 120-second boundary expires, and receipts are peer-specific.
  siblings.receiveHop(own, 'mitil', 2, 1000)
  assert.equal(siblings.nextHop(own, 'mitil', 120999), 3)
  assert.equal(siblings.nextHop(own, 'mitil', 121000), 1)
  siblings.receiveHop(own, 'mitil', 2)
  assert.equal(siblings.nextHop(own, 'unrelated'), 1)
  assert.equal((await peerInbound({ text: 'human on B' })).status, 202)
  assert.equal(siblings.nextHop(peer, 'default'), 1)

  const memory = await import('../memory/service.mjs')
  assert.match(memory.journalRead({}).rows.find(row => row.body.includes('hello')).body, /미틸 \(mitil\).*hello/)
  memory.close()
  console.log('test-sibling-channel: all assertions passed (real loopback chain, human reset, Discord isolation, forged and invalid hops, expiry, SYSTEM spoof)')
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve))
  siblings.resetHops(own); siblings.resetHops(peer)
  fs.rmSync(root, { recursive: true, force: true })
}
