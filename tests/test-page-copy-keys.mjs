// Every page script that aliases a COPY section (`const C = window.COPY.settings`)
// must only read keys that section actually has. A missing object key is not
// an empty string: `C.step1b.copy(0)` threw inside settings.js init() and left
// the whole Settings page without text (shipped in 0.3.6 and 0.3.7, Mino 09-29).
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const JS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'onboarding', 'public', 'js')
const doc = { querySelector: () => null, documentElement: { dataset: {} } }
const ctx = { window: {}, document: doc, navigator: { platform: 'MacIntel', userAgent: 'Mac' }, console }
Object.assign(ctx.window, { document: doc, navigator: ctx.navigator })
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(JS, 'call-copy.cjs'), 'utf8'), ctx)
vm.runInContext(fs.readFileSync(path.join(JS, 'copy.js'), 'utf8'), ctx)
const COPY = ctx.window.COPY
assert.ok(COPY && typeof COPY === 'object', 'copy.js did not define window.COPY')

let checked = 0
const problems = []
for (const f of fs.readdirSync(JS).filter((n) => n.endsWith('.js') && n !== 'copy.js')) {
  const src = fs.readFileSync(path.join(JS, f), 'utf8')
  for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*window\.COPY\.([A-Za-z_$][\w$]*)\s*$/gm)) {
    const [, alias, section] = m
    const sec = COPY[section]
    if (sec === undefined) { problems.push(`${f}: COPY.${section} does not exist`); continue }
    if (typeof sec !== 'object') continue // e.g. COPY.genericError is a function
    const re = new RegExp(`(?<![\\w$.])${alias.replace('$', '\\$')}\\.([A-Za-z_$][\\w$]*)`, 'g')
    for (const u of new Set([...src.matchAll(re)].map((x) => x[1]))) {
      checked++
      if (!(u in sec)) problems.push(`${f}: ${alias}.${u} (COPY.${section}.${u}) is missing`)
    }
  }
}
assert.ok(checked > 50, `only ${checked} key reads found; the alias scan is broken`)
assert.deepEqual(problems, [], problems.join('\n'))
console.log(`ok: ${checked} COPY key reads resolve`)
