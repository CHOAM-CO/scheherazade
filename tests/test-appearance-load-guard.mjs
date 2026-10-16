import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const M = require('../onboarding/public/js/appearance-model.cjs')
const source = fs.readFileSync(new URL('../onboarding/public/js/appearance.js', import.meta.url), 'utf8')
async function mount(fail) {
 const elements = new Map(), requests = []
 const get = id => { if (!elements.has(id)) elements.set(id, { value:'', disabled:false, dataset:{}, style:{}, textContent:'', events:{}, classList:{add(){},toggle(){},remove(){}}, setAttribute(){}, appendChild(){}, querySelectorAll:()=>[], addEventListener(name,fn){this.events[name]=fn} });return elements.get(id) }
 let init
 const copy = new Proxy({}, { get: () => ({}) })
 vm.runInNewContext(source, { window:{ AppearanceModel:M, COPY:{appearance:copy}, api:async (url,opts)=>{requests.push(opts);if(fail)throw Error('offline');return {values:M.DEFAULTS,supportsBlur:true}} }, document:{getElementById:get,createElement:()=>get('new-'+elements.size),querySelectorAll:()=>[get('ap-reset')],addEventListener:(_name,fn)=>init=fn,head:{appendChild(){}}}, setTimeout:()=>1, clearTimeout(){} })
 await init()
 return {get, requests}
}
const failed=await mount(true)
assert.equal(failed.get('ap-reset').disabled,true)
assert.match(failed.get('ap-status').textContent,/Could not load/)
failed.get('ap-reset').events.click()
assert.equal(failed.requests.length,1)
const ready=await mount(false)
assert.equal(ready.get('ap-reset').disabled,false)
ready.get('ap-fg-picker').events.input({target:{value:M.DEFAULTS.bg}})
assert.match(ready.get('ap-status').textContent,/different colors/)
assert.equal(ready.get('ap-fg-picker').value,M.DEFAULTS.fg)
const luminance=hex=>{const c=hex.slice(1).match(/../g).map(v=>parseInt(v,16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722}
const vars=M.cssVars(M.DEFAULTS), ratio=(luminance(vars['--fg-faint'])+.05)/(luminance(M.DEFAULTS.bg)+.05)
assert.ok(ratio>=4.5,`contrast ${ratio}`)
console.log(`Appearance read-before-write, invisible-text rollback, default faint contrast ${ratio.toFixed(2)}:1 passed`)
