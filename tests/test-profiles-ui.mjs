import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
class Element {
  constructor() { this.children = []; this.attributes = {}; this.value = ''; this.textContent = ''; this.disabled = false }
  appendChild(el) { this.children.push(el); return el }
  replaceChildren() { this.children = [] }
  setAttribute(key, value) { this.attributes[key] = value }
  focus() { assert.equal(this.disabled, false); this.focused = true }
}
const elements = Object.fromEntries(['title', 'name', 'validation', 'create', 'retry', 'list', 'status', 'form', 'copy-settings', 'shared-memory'].map(key => [`profiles-${key}`, new Element()]))
elements['profiles-copy-settings'].checked = true
const document = { documentElement: { lang: 'ko' }, querySelector: () => null, querySelectorAll: () => [], getElementById: id => elements[id], createElement: () => new Element() }
const server = { ok: true, current: 'work', profiles: [
  { name: '', displayName: '세라', running: true, isDefault: true },
  { name: 'work', displayName: '<script>unsafe</script>', running: true },
  { name: 'rest', displayName: '쉬는 세라', running: false },
] }
const calls = [], toasts = [], confirms = []
let fail = null, consent = false, release = null, gate = null
const window = { showToast: text => toasts.push(text), confirmDialog: async text => { confirms.push(text); return consent }, profilesReady: Promise.resolve(server), api: async (url, options) => {
  calls.push({ url, options })
  if (gate) await gate
  if (fail) throw fail
  if (!options) return server
  if (url === '/api/profiles') {
    const { name } = JSON.parse(options.body)
    server.profiles.push({ name, displayName: name, running: false })
  }
  if (url === '/api/profiles/settings') server.sharedMemoryRead = JSON.parse(options.body).sharedMemoryRead
  if (options.method === 'DELETE') server.profiles = server.profiles.filter(p => url !== `/api/profiles/${p.name}`)
  return { ok: true, path: '/shortcuts/rest.command' }
} }
const context = { window, document, navigator: { language: 'ko' }, console }
vm.runInNewContext(read('onboarding/public/js/copy.js'), context)
await vm.runInNewContext(read('onboarding/public/js/profiles.js'), context)
const $ = key => elements[`profiles-${key}`]
const row = index => $('list').children[index]
const actions = index => row(index).children.at(-1).children
assert.equal($('shared-memory').checked, true)
$('shared-memory').checked = false
await $('shared-memory').onchange()
assert.equal(server.sharedMemoryRead, false)
assert(read('onboarding/public/profiles.html').includes('id="profiles-copy-settings" checked'))
assert.equal($('list').children.length, 3)
assert.equal(row(1).children[0].textContent, '<script>unsafe</script> (work)')
assert.equal(actions(0)[2].disabled, true)
assert.equal(actions(1)[2].disabled, true)
assert.equal(actions(2)[2].disabled, false)
assert.equal(actions(1)[2].attributes['aria-describedby'], 'profiles-reason-1')
assert(row(1).children.some(el => el.textContent === '현재'))
for (const name of ['', 'Upper', 'with space', 'a'.repeat(25), 'default', 'work']) {
  $('name').value = name; $('name').oninput(); assert.equal($('create').disabled, true, name)
}
$('name').value = 'new-sera'; $('name').oninput(); assert.equal($('create').disabled, false)
await $('form').onsubmit({ preventDefault() {} })
assert.equal(JSON.parse(calls.find(c => c.url === '/api/profiles' && c.options?.body)?.options.body).copyFrom, true)
assert.equal(JSON.parse(calls.find(c => c.url === '/api/profiles' && c.options?.body).options.body).name, 'new-sera')
assert(calls.some(c => c.url === '/api/profiles/new-sera/open'))
assert.equal($('name').value, '')
assert.equal($('name').focused, true)
await actions(2)[2].onclick()
assert(!calls.some(c => c.options?.method === 'DELETE'))
assert.match(confirms[0], /두 폴더 모두 휴지통/)
consent = true; fail = Object.assign(Error('busy'), { status: 409 })
await actions(2)[2].onclick()
assert.equal(toasts.at(-1), '먼저 그 세라를 닫아줘')
fail = null
await actions(2)[1].onclick()
assert.match(toasts.at(-1), /\/shortcuts\/rest.command/)
await actions(0)[0].onclick()
assert(calls.some(c => c.url === '/api/profiles/default/open'))
gate = new Promise(resolve => { release = resolve })
const pending = actions(2)[0].onclick()
assert.equal(actions(2)[1].disabled, true)
release(); await pending; gate = null
await actions(2)[2].onclick()
assert.equal($('list').children.length, 3)
assert.equal($('retry').focused, true)
fail = Error('disk full')
await $('retry').onclick()
assert.match(toasts.at(-1), /disk full/)
assert.equal($('retry').disabled, false)
assert.equal(window.COPY.profiles.error(Error('{"error":"oops"}')), window.COPY.profiles.failed)
const nav = read('onboarding/public/js/nav.js')
assert.match(nav, /id: 'profiles', key: 'profiles', href: '\/profiles.html'/)
assert.match(nav, /new Set\(\['settings', 'channels', 'appearance', 'profiles'\]\)/)
assert.match(nav, /error.status = res.status/)
// Execute shared identity initialization independently of nav's status polling.
const identity = nav.slice(nav.indexOf('// Named profiles stay identifiable'))
const label = new Element(); label.textContent = 'Sera'
const titleDocument = { title: 'Scheherazade - Chat', getElementById: () => label }
const identityWindow = { api: async () => server, COPY: window.COPY, showToast: window.showToast }
await vm.runInNewContext(identity, { window: identityWindow, document: titleDocument })
assert.equal(titleDocument.title, '[work] Scheherazade - Chat')
assert.equal(label.textContent, '[work] Sera')
server.current = ''; titleDocument.title = 'Scheherazade'
await vm.runInNewContext(identity, { window: identityWindow, document: titleDocument })
assert.equal(titleDocument.title, 'Scheherazade')
// design-0029: optional global discovery must never toast, including missing routes.
for (const error of [Error('network failed'), Object.assign(Error('missing route'), { status: 404 })]) {
  const before = toasts.length
  const failingWindow = { ...identityWindow, api: async () => { throw error } }
  await vm.runInNewContext(identity, { window: failingWindow, document: titleDocument })
  assert.equal(await failingWindow.profilesReady, null)
  assert.equal(toasts.length, before)
}
for (const lang of ['en', 'ko']) {
  const localized = { window: {}, document: { ...document, documentElement: { lang } }, navigator: { language: lang } }
  vm.runInNewContext(read('onboarding/public/js/copy.js'), localized)
  assert.equal(localized.window.COPY.polish.profiles, lang === 'en' ? 'Profiles' : '세라 프로필')
  assert.notEqual(localized.window.COPY.polish.profiles, localized.window.COPY.polish.identity)
  if (lang === 'en') assert.equal(localized.window.COPY.profiles.create, 'Create a Sera')
}
// Initial list failure leaves creation disabled and offers a working retry.
fail = null; window.profilesReady = Promise.resolve(null)
await vm.runInNewContext(read('onboarding/public/js/profiles.js'), context)
assert.equal($('status').textContent, window.COPY.profiles.failed)
assert.equal($('create').disabled, true)
await $('retry').onclick()
assert.equal($('list').children.length, server.profiles.length)
const html = read('onboarding/public/profiles.html')
assert.match(html, /class="settings-rail"/)
assert.match(html, /for="profiles-name"/)
assert.match(html, /aria-describedby="profiles-helper profiles-validation"/)
assert.match(html, /class="toast" role="status"/)
console.log('Profiles UI: validation, actions, confirmation, 409, failures, busy state, safe text, focus, rail and identity passed')
