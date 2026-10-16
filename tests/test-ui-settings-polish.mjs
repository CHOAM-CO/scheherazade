import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8')
const chat = read('onboarding/public/js/chat.js')
assert.match(chat, /details.append\(pathText\)/)
assert.match(chat, /details.append\(copy\)/)
assert.match(chat, /Connect Chrome extension/)
assert.match(chat, /Extension missing/)
assert.match(chat, /popover.prepend\(line\)/)
const route = read('onboarding/routes/quickbar.cjs')
assert.match(route, /extensionPresent: fs.existsSync/)
assert.match(chat, /!window.SCHZ_EFFORT_LEVELS.includes\(msEffort\)/)
assert.match(read('onboarding/public/js/connectors.js'), /!EFFORT_LEVELS.includes\(effort\)/)
// The displayed current value must survive population, including lane-specific off.
const fn = chat.match(/  function msPopulateEffort\(\) \{[\s\S]*?\n  \}/)[0]
for (const effort of ['off', 'medium']) {
 const options = []
 vm.runInNewContext(`${fn}; msPopulateEffort()`, { msEffort: effort, effortSel: { replaceChildren() {}, appendChild: e => options.push(e) }, document: { createElement: () => ({}) }, window: { SCHZ_EFFORT_LEVELS: ['low','medium','high'], SCHZ_EFFORT_DEFAULT: 'high' } })
 assert.equal(options.find(o => o.selected).value, effort)
 assert.equal(options.filter(o => o.value === effort).length, 1)
}
console.log('Pairing disclosure, status and effort preservation passed')

const wizard = read('onboarding/public/index.html')
for (const id of ['s2-back','s3-back','wizard-progress']) assert.ok(wizard.includes(`id="${id}"`))
assert.doesNotMatch(wizard.replace(/<!--[\s\S]*?-->/g,''), /[가-힣]/)
assert.match(read('onboarding/public/js/wizard.js'), /heading.focus\(\)/)
assert.match(read('onboarding/public/js/call.js'), /slot.replaceChildren\(row, hint\)/)
assert.doesNotMatch(read('onboarding/public/css/companion.css').match(/@media \(prefers-reduced-motion: reduce\) \{\n  #orb[\s\S]*?\n\}/)[0], /infinite/)
const logs = read('onboarding/public/js/logs.js')
assert.match(logs, /writeText\(shown.map/)
assert.match(logs, /writeText\(lines.map/)
assert.match(read('onboarding/public/js/memory.js'), /state.recentError/)
console.log('Onboarding language and navigation, stable call anchor, reduced motion and log copy modes passed')
