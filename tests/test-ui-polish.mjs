import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const read = p => fs.readFileSync(new URL(p, root), 'utf8')
const css = read('onboarding/public/css/app.css')
assert.match(css, /\.usage-seg \{ display: grid; grid-template-columns: 3\.4rem minmax\(0, 1fr\) 4\.6rem 7rem/)
assert.match(css, /@media \(max-width: 860px\)/)
assert.match(css, /@media \(max-width: 600px\)/)
const context = { window: {}, document: { querySelector: () => null } }
vm.runInNewContext(read('onboarding/public/js/copy.js'), context)
for (const locale of ['en', 'ko']) {
 const copy = context.window.UI_POLISH_COPY[locale]
 assert.equal(typeof copy.newLines(5), 'string')
 for (const v of Object.values(copy)) if (typeof v === 'string') assert.ok(!v.includes('—'))
}
const { createRoutes } = require('../onboarding/routes/permissions.cjs')
let opened, result
const routes = createRoutes({
 sendJson: (_res, status, body) => { result = { status, body } },
 logBuffer: { getSince: () => ({ file: '/server/owned/app.log' }) },
 getElectron: () => ({ shell: { openPath: async p => { opened = p; return '' } } }),
})
const route = routes.find(r => r.match('/api/logs/open'))
assert.equal(route.method, 'POST')
await route.handler({ body: { path: '/untrusted/other' } }, {})
assert.equal(opened, '/server/owned/app.log')
assert.deepEqual(result, { status: 200, body: { ok: true } })
const missing = createRoutes({ sendJson: (_res, status) => { result = status }, logBuffer: { getSince: () => ({file:null}) }, getElectron: () => ({}) }).find(r => r.match('/api/logs/open'))
await missing.handler({}, {})
assert.equal(result, 503)
assert.match(read('onboarding/public/js/logs.js'), /new RegExp\(q, 'i'\)/)
assert.match(read('onboarding/public/js/logs.js'), /text\.toLowerCase\(\)\.includes/)
assert.match(read('onboarding/public/js/logs.js'), /lines = lines\.slice\(-3000\)/)
assert.match(read('onboarding/public/settings.html'), /href="\/channels"/)
assert.match(read('onboarding/public/settings.html'), /href="\/appearance"/)
console.log('ok: UI polish responsive grids, both locales, bounded logs and server-owned file-open route')
