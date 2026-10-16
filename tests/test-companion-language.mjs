import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = file => fs.readFileSync(new URL('../onboarding/public/' + file, import.meta.url), 'utf8')
const html = read('companion.html')
assert.match(html, /<html lang="en">/)
assert.doesNotMatch(html, /[가-힣]/)
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
assert.match(read('js/call.js'), /hangup.textContent = ko \? '통화 종료' : 'End call'/)
console.log('Companion English markup, Korean gate, compose hint and call label passed')
