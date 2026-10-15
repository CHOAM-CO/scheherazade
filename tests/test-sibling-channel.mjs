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
  assert.match(local.siblingTools()[0].description, /mitil \(미틸, 꺼짐\)/)
  assert.match(local.siblingTools(peer)[0].description, /default \(Original, 꺼짐\)/)
  assert.match(local.siblingTools()[0].description, /기본 세라의 name은 default/)
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

  // Display-name resolution uses exact, case-insensitive config values.
  fs.writeFileSync(path.join(peer, '.agent-config'), 'PROFILE=mitil\nDISPLAY_NAME=MiTiL\n')
  assert.match(local.siblingTools()[0].description, /mitil \(MiTiL, 꺼짐\)/)
  await siblings.say(own, 'mItIl', 'display alias')
  assert.equal(peerNotifications.at(-1).params.meta.hop, 1)
  fs.writeFileSync(path.join(peer, '.agent-config'), 'PROFILE=mitil\nDISPLAY_NAME=미틸\n')

  // A -> B (hop 1), B -> A (hop 2), A -> B (hop 3) is rejected.
  await siblings.say(own, 'mitil', 'first')
  assert.equal(peerNotifications.at(-1).params.meta.hop, 1)
  await siblings.say(peer, 'oRiGiNaL', 'hello')
  assert.equal(notifications.at(-1).params.meta.sender, '미틸 (mitil)')
  assert.equal(notifications.at(-1).params.meta.sibling, true)
  assert.equal(notifications.at(-1).params.meta.hop, 2)
  assert.match(notifications.at(-1).params.content, /자동으로 다른 세라에게 전달하지 않기/)
  assert(notifications.at(-1).params.content.endsWith("(답장은 '다른 세라에게 말하기'로 mitil에게 보내. 대화는 왕복 한 번까지.)"))
  assert(peerNotifications.at(-1).params.content.endsWith("(답장은 '다른 세라에게 말하기'로 default에게 보내. 대화는 왕복 한 번까지.)"))
  const rows = local.readOutbound(0).items
  assert.equal(rows.at(-1).from, '미틸 (mitil)')
  assert.equal(rows.at(-1).sibling, true)
  const beforeRejection = peerNotifications.length
  const blocked = await local.handleToolCall('profile_say', { name: 'mitil', text: 'echo' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.content[0].text, /^대화가 길어져서 여기서 끊어. 사람이 이어 줘/)
  assert.match(blocked.content[0].text, /사용 가능한 name: mitil/)
  assert.equal(peerNotifications.length, beforeRejection)
  // Rejection must preserve the receiver's receipt.
  assert.equal(siblings.nextHop(peer), 2)

  // A queued local human message resets the receipt, not a global turn flag.
  assert.equal((await inbound({ text: 'human asks a fresh question' })).status, 202)
  assert.equal(notifications.at(-1).params.content, 'human asks a fresh question')
  assert(!notifications.at(-1).params.content.includes('답장은'))
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

  // Forged high hops never deliver or clear existing receipts.
  const beforeForged = notifications.length
  const forged = await inbound({ text: 'forged', from: '미틸 (mitil)', sibling: true, hop: 999 })
  assert.equal(forged.status, 409)
  assert.equal(forged.body.code, 'sibling_loop')
  assert.equal(notifications.length, beforeForged)
  assert.equal(siblings.nextHop(own), 3)
  for (const hop of [undefined, 0, -1, 1.5, '2', null]) {
    assert.equal((await inbound({ text: 'invalid hop', from: '미틸 (mitil)', sibling: true, hop })).status, 400)
  }
  const spoof = await inbound({ text: 'spoof', from: '시스템', sibling: true, hop: 1 })
  assert.equal(spoof.status, 400)
  const notice = await inbound({ text: 'notice', from: '시스템 (mitil)', sibling: true, hop: 1 })
  assert.equal(notice.status, 202)
  assert.equal(notifications.at(-1).params.meta.sender, '시스템 (mitil)')
  assert.notEqual(notifications.at(-1).params.meta.sender, 'SYSTEM')

  // Notices leave both empty and existing budgets unchanged.
  siblings.resetHops(own)
  assert.equal((await inbound({ text: 'created', from: '시스템 (mitil)', sibling: true, notice: true })).status, 202)
  assert.equal(siblings.nextHop(own), 1)
  siblings.receiveHop(own, 'mitil', 2)
  await inbound({ text: 'created again', from: '시스템 (mitil)', sibling: true, notice: true, hop: 999 })
  assert.equal(siblings.nextHop(own), 3)

  // Three profiles cannot evade the budget by changing the next destination.
  const third = path.join(root, 'Scheherazade-third')
  fs.mkdirSync(third)
  fs.writeFileSync(path.join(third, '.agent-config'), 'PROFILE=third\nDISPLAY_NAME=Third\n')
  const thirdNotifications = []
  await listen(third, thirdNotifications)
  siblings.resetHops(own); siblings.resetHops(peer)
  await siblings.say(own, 'mitil', 'A to B')
  await siblings.say(peer, 'third', 'B to C')
  assert.equal(thirdNotifications.at(-1).params.meta.hop, 2)
  const beforeThirdHop = notifications.length
  await assert.rejects(siblings.say(third, 'default', 'C to A'), error => error.code === 'sibling_loop')
  assert.equal(notifications.length, beforeThirdHop)

  // Ambiguous display names enumerate canonical names without any delivery.
  fs.writeFileSync(path.join(third, '.agent-config'), 'PROFILE=third\nDISPLAY_NAME=미틸\n')
  await assert.rejects(siblings.say(own, '미틸', 'ambiguous'), error => {
    assert.equal(error.status, 400)
    assert.equal(error.code, 'ambiguous_profile')
    assert.deepEqual(error.matches, ['mitil', 'third'])
    assert.deepEqual(error.validNames, ['mitil', 'third'])
    return true
  })
  // Canonical profile names still disambiguate duplicate display names.
  siblings.resetHops(own)
  await siblings.say(own, 'third', 'canonical target')
  assert.equal(thirdNotifications.at(-1).params.meta.hop, 1)
  await assert.rejects(siblings.say(own, 'no such sera', 'missing'), error => error.status === 404 && error.validNames.includes('mitil') && error.message.includes('third'))
  fs.writeFileSync(path.join(third, '.agent-config'), 'PROFILE=third\nDISPLAY_NAME=Third\n')

  // Two sends 130 seconds apart still use the highest receipt, across targets.
  const savedFetch = globalThis.fetch, savedNow = Date.now
  const sent = []
  let clock = 1000
  try {
    Date.now = () => clock
    globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true } }
    await siblings.say(peer, 'third', 'first timed send')
    clock += 130000
    await siblings.say(peer, 'default', 'second timed send')
    assert.deepEqual(sent.map(message => message.hop), [2, 2])
  } finally { globalThis.fetch = savedFetch; Date.now = savedNow }
  // A later lower receipt cannot reduce the high-water budget.
  siblings.receiveHop(own, 'mitil', 2)
  siblings.receiveHop(own, 'mitil', 1)
  assert.equal(siblings.nextHop(own), 3)
  assert.equal((await peerInbound({ text: 'human on B' })).status, 202)
  assert.equal(siblings.nextHop(peer), 1)

  // Sender labels with punctuation and long names are safe on the wire.
  siblings.resetHops(own)
  fs.writeFileSync(path.join(own, '.agent-config'), `DISPLAY_NAME=${'<["quoted"]>'.repeat(30)}\n`)
  await siblings.say(own, 'mitil', 'sanitised sender')
  const safeSender = peerNotifications.at(-1).params.meta.sender
  assert(!/[<>[\]"']/.test(safeSender))
  assert(safeSender.endsWith(' (default)'))
  assert(safeSender.length <= 130)
  assert.throws(() => siblings.senderLabel('safe', 'BAD'), error => error.code === 'bad_sender')
  const badSender = await inbound({ text: 'bad', from: '<unsafe> (mitil)', sibling: true, hop: 1 })
  assert.equal(badSender.body.code, 'bad_sender')
  // Remote bad_sender responses are not misreported as profile_off.
  try {
    globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: 'bad_sender' }) })
    await assert.rejects(siblings.say(own, 'mitil', 'bad remote sender'), error => error.code === 'bad_sender')
  } finally { globalThis.fetch = savedFetch }

  const memory = await import('../memory/service.mjs')
  assert.match(memory.journalRead({}).rows.find(row => row.body.includes('hello')).body, /미틸 \(mitil\).*hello/)
  memory.close()
  console.log('test-sibling-channel: all assertions passed (real loopback chain, human reset, Discord isolation, forged and invalid hops, three-profile budget, no decay, notice isolation, safe sender, SYSTEM spoof)')
} finally {
  for (const server of servers) await new Promise(resolve => server.close(resolve))
  siblings.resetHops(own); siblings.resetHops(peer)
  fs.rmSync(root, { recursive: true, force: true })
}
