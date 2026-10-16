import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
const source = fs.readFileSync(new URL('../onboarding/public/js/chat.js', import.meta.url), 'utf8')
const start = source.indexOf("  document.addEventListener('keydown', (event) => {")
const end = source.indexOf('\n  async function requestStop()', start)
let handler; let stopped = 0; let inFlight = true
const document = { activeElement: null, addEventListener: (_type, callback) => { handler = callback } }
vm.runInNewContext(source.slice(start, end), { document, deriveTurn: () => ({ inFlight }), turnState: 'working', requestStop: () => stopped++ })
const escape = extra => ({ key: 'Escape', preventDefault () { this.defaultPrevented = true }, ...extra })
handler(escape({ isComposing: true }))
handler(escape({ defaultPrevented: true }))
handler(escape({ target: { closest: () => ({}) } }))
document.activeElement = { closest: () => ({}) }
handler(escape())
document.activeElement = null
assert.equal(stopped, 0, 'IME and overlay dismissal never stop a turn')
handler(escape())
assert.equal(stopped, 1)
inFlight = false
handler(escape())
assert.equal(stopped, 1, 'Escape with no turn is inert')
assert.doesNotMatch(source, /textContent = document.documentElement.lang.startsWith\('ko'\) \? '세부 정보'/)
assert.match(source, /Q.qbDetails/)
assert.match(source, /Q.qbConnect/)
console.log('PASS Escape respects IME/default prevention and overlay focus; quickbar uses COPY')
