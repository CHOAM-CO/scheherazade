// afterPack onnx trim: each platform keeps only its own bin/napi-v6/<os>.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { trimUnpacked } = require('../tools/onnx-natives-trim.cjs')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const src = path.join(root, 'node_modules/onnxruntime-node/bin/napi-v6')
if (!fs.existsSync(src)) { console.log('SKIP: onnxruntime-node not installed'); process.exit(0) }
let fails = 0
const ok = (n, c) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}`); if (!c) fails++ }
for (const plat of ['darwin', 'linux', 'win32']) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'onnxtrim-'))
  const dest = path.join(tmp, 'node_modules/onnxruntime-node/bin/napi-v6')
  fs.mkdirSync(dest, { recursive: true })
  for (const o of ['darwin', 'linux', 'win32']) {
    fs.mkdirSync(path.join(dest, o), { recursive: true })
    fs.writeFileSync(path.join(dest, o, 'x.node'), 'stub')
  }
  trimUnpacked(tmp, plat)
  const left = fs.readdirSync(dest).sort()
  ok(`${plat} keeps only ${plat} (left: ${left})`, left.length === 1 && left[0] === plat)
  fs.rmSync(tmp, { recursive: true, force: true })
}
const t2 = fs.mkdtempSync(path.join(os.tmpdir(), 'onnxtrim-'))
ok('unknown platform removes nothing, no throw', trimUnpacked(t2, 'freebsd').length === 0)
fs.rmSync(t2, { recursive: true, force: true })
process.exit(fails ? 1 : 0)
