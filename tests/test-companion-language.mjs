import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = file => fs.readFileSync(new URL('../onboarding/public/' + file, import.meta.url), 'utf8')
const html = read('companion.html')
assert.match(html, /<html lang="en">/)
assert.doesNotMatch(html, /[가-힣]|Stop reading/)
assert.match(html, /aria-label="Stop voice" title="Stop speaking the reply aloud"/)
assert.match(html, /companion-copy.js[\s\S]*companion.js/)
const source = read('js/companion-copy.js')
for (const [lang, expected] of [['en', 'Talk to Sera'], ['ko', '세라와 이야기하기']]) {
  const attrs = { title: 'Talk to Sera' }
  const node = { nodeType: 3, textContent: 'Reply' }
  const element = { getAttribute: key => attrs[key], setAttribute: (key, value) => attrs[key] = value, childNodes: [node] }
  vm.runInNewContext(source, { document: { documentElement: { lang }, querySelectorAll: () => [element] } })
  assert.equal(attrs.title, expected)
  assert.equal(node.textContent, lang === 'ko' ? '답장' : 'Reply')
}
assert.match(read('js/companion.js'), /b.kind === 'compose' \? \(ko \?/)
assert.match(read('js/call.js'), /hangup.textContent = V.endCall/)
console.log('Companion English markup, Korean gate, compose hint and call label passed')

const firstOpen = read('js/companion.js').match(/    if \(!checkedFirstOpen && state.enabled\) \{[\s\S]*?\n    const orbMode/)[0].replace(/\n    const orbMode$/, '')
const stored = new Map(), commands = []
const context = { state: { enabled: true, bubble: null }, window: { localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) } }, command: name => { commands.push(name); return Promise.resolve({}) }, render() {}, showFailure() {} }
vm.runInNewContext(`let checkedFirstOpen = false; ${firstOpen}; ${firstOpen}`, context)
assert.deepEqual(commands, ['open'])
vm.runInNewContext(`let checkedFirstOpen = false; ${firstOpen}`, { ...context })
assert.deepEqual(commands, ['open'])
console.log('First-open hint appears once without changing voice or microphone settings')

const { createRequire } = await import('node:module')
const shared = createRequire(import.meta.url)('../onboarding/call-context.cjs')
for (const lang of ['en', 'ko']) {
  const ctx = { window: {}, document: { documentElement: { lang }, querySelector: () => null }, navigator: { platform: 'MacIntel', userAgent: 'Mac' }, console }
  vm.createContext(ctx)
  vm.runInContext(read('js/call-copy.cjs'), ctx)
  vm.runInContext(read('js/copy.js'), ctx)
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.window.COPY.callContext)), shared[lang])
  assert.equal(ctx.window.COPY.call.stopVoice, lang === 'en' ? 'Stop voice' : '음성 멈춤')
  assert.equal(ctx.window.COPY.call.endCall, lang === 'en' ? 'End call' : '통화 종료')
}
for (const page of ['chat', 'settings', 'companion']) assert.match(read(page + '.html'), /call-copy.cjs[\s\S]*copy.js/)
console.log('Node notices and localized browser call COPY share one source passed')
