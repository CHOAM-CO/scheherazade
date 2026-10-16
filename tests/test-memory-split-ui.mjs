import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
class Element {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.checked = true; this.textContent = ''; this.value = '' }
  append(...nodes) { this.childNodes.push(...nodes) }
  replaceChildren() { this.childNodes = [] }
  setAttribute() {}
}
const elements = Object.fromEntries(['sibling-memory', 'sibling-memory-toggle', 'sibling-memory-blocks', 'own-memory-title', 'sibling-memory-title', 'sibling-memory-toggle-label', 'sibling-memory-help'].map(id => [id, new Element('div')]))
const calls = []
const window = { COPY: { siblingMemory: { own: '내 기억', title: '다른 세라 기억', toggle: '보기', help: '읽기 전용', search: '검색', submit: '검색', empty: '없음', failed: '실패', summary: (name, profile, count, date) => `${name} (${profile}) · ${count}개 · ${date}` } }, showToast: assert.fail, api: async (url, options) => {
  calls.push({ url, options })
  if (url === '/api/profiles/settings') return { ok: true, sharedMemoryRead: true }
  return { siblings: [{ name: '<unsafe>', profile: 'Scheherazade-work', material: { count: 3, lastWritten: '2026-10-15', rows: url.includes('?') ? [{ value: '<script>data</script>' }] : [] } }] }
} }
const document = { querySelector: () => ({ content: 'true' }), getElementById: id => elements[id], createElement: tag => new Element(tag) }
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
assert(html.includes('id="own-memory-title" hidden') && html.includes('id="sibling-memory" hidden') && html.includes('/js/memory.js'))
calls.length = 0
document.querySelector = () => ({ content: 'false' })
await vm.runInNewContext(source, { window, document })
assert.equal(calls.length, 0)
console.log('test-memory-split-ui: pass=9 fail=0')

const memorySource = fs.readFileSync(new URL('../onboarding/public/js/memory.js', import.meta.url), 'utf8')
assert.match(memorySource, /el\('div', 'entry-value markdown-body'\)/)
assert.match(memorySource, /window.renderMarkdown\(value, formatted.value\)/)
assert.match(memorySource, /value: String\(row.value \?\? ''\)/)
assert.match(memorySource, /value: String\(row.summary \?\? ''\)/)
assert.doesNotMatch(memorySource, /el\('div', 'entry-value', formatted.value\)/)
console.log('About-you table values use shared markdown; nullable text normalized passed')

// Run memory.js's actual table renderer and formatters with the real markdown
// renderer, rather than asserting only that a source call site exists.
Element.prototype.appendChild = function (node) { this.childNodes.push(node); return node }
const memoryDocument = {
  createElement: tag => new Element(tag),
  createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node },
}
const renderedTable = new Element('main')
const memoryWindow = {}
const memoryContext = vm.createContext({
  window: memoryWindow, document: memoryDocument,
  C: { categories: { user_facts: { label: 'About you' } }, deleteLabel: 'Delete' },
  F: { tableIntro: () => '' }, displayName: 'Sera', state: { renderSeq: 1 },
  isoDate: value => value || '',
  resetReader: () => renderedTable,
  api: async () => ({ ownerProfile: 'test', rows: [{ id: 1, value: '**Desktop**' }] }),
})
vm.runInContext(fs.readFileSync(new URL('../onboarding/public/js/markdown.js', import.meta.url), 'utf8'), memoryContext)
const formatters = memorySource.slice(memorySource.indexOf('  const ROW_FORMATTERS ='), memorySource.indexOf("  let displayName ="))
const elementFactory = memorySource.slice(memorySource.indexOf('  function el('), memorySource.indexOf('\n  }', memorySource.indexOf('  function el(')) + 4)
const tableRenderer = memorySource.slice(memorySource.indexOf('  async function viewTable('), memorySource.indexOf('  async function viewSession('))
await vm.runInContext(`${formatters}\n${elementFactory}\n${tableRenderer}\nviewTable(1, 'user_facts')`, memoryContext)
function descendants(node) { return node.childNodes.flatMap(child => [child, ...descendants(child)]) }
const renderedValue = descendants(renderedTable).find(node => node.className === 'entry-value markdown-body')
assert(renderedValue)
const bold = descendants(renderedValue).find(node => node.tag === 'strong')
assert(bold, 'stored markdown creates a strong element inside entry-value')
assert.equal(bold.childNodes[0].textContent, 'Desktop')
console.log('Rendered About-you table: **Desktop** becomes entry-value > p > strong passed')
