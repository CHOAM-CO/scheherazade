import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
class Element {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.checked = true; this.textContent = ''; this.value = '' }
  append(...nodes) { this.childNodes.push(...nodes) }
  replaceChildren() { this.childNodes = [] }
  setAttribute() {}
}
const elements = Object.fromEntries(['sibling-memory', 'sibling-memory-toggle', 'sibling-memory-blocks'].map(id => [id, new Element('div')]))
const calls = []
const window = { showToast: assert.fail, api: async (url, options) => {
  calls.push({ url, options })
  if (url === '/api/profiles/settings') return { ok: true, sharedMemoryRead: true }
  return { siblings: [{ name: '<unsafe>', profile: 'Scheherazade-work', material: { count: 3, lastWritten: '2026-10-15', rows: url.includes('?') ? [{ value: '<script>data</script>' }] : [] } }] }
} }
const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) }
const source = fs.readFileSync(new URL('../onboarding/public/js/sibling-memory.js', import.meta.url), 'utf8')
await vm.runInNewContext(source, { window, document })
const blocks = elements['sibling-memory-blocks']
assert.equal(blocks.childNodes.length, 1)
const [summary, form, output] = blocks.childNodes[0].childNodes
assert.match(summary.textContent, /<unsafe>.*3개.*2026-10-15/)
assert.equal(blocks.childNodes[0].tag, 'details')
assert.equal(form.childNodes[0].type, 'search')
form.childNodes[0].value = 'tea'
await form.onsubmit({ preventDefault() {} })
assert.equal(output.childNodes[0].textContent, '<script>data</script>')
assert(!calls.some(c => c.options?.method === 'DELETE'))
elements['sibling-memory-toggle'].checked = false
await elements['sibling-memory-toggle'].onchange()
assert.equal(blocks.childNodes.length, 0)
assert.equal(JSON.parse(calls.at(-1).options.body).sharedMemoryRead, false)
const html = fs.readFileSync(new URL('../onboarding/public/memory.html', import.meta.url), 'utf8')
assert(html.includes('내 기억') && html.includes('다른 세라 기억') && html.includes('/js/memory.js'))
console.log('test-memory-split-ui: pass=9 fail=0')
