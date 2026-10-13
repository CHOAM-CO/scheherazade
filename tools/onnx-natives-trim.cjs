'use strict'
// electron-builder afterPack hook: keep only the target platform's
// onnxruntime-node prebuilt binaries. node_modules/** is asarUnpack'd, so the
// foreign bin/napi-v6/<os> trees land in resources/app.asar.unpacked and are
// removed here. (Per-platform `files` arrays of only `!` patterns are NOT used:
// electron-builder reads them as `**/*` plus negations.)
const fs = require('node:fs')
const path = require('node:path')

const OSES = ['darwin', 'linux', 'win32']
const REL = path.join('node_modules', 'onnxruntime-node', 'bin', 'napi-v6')

function trimUnpacked(unpackedRoot, platform) {
  const removed = []
  if (!OSES.includes(platform)) return removed
  const base = path.join(unpackedRoot, REL)
  for (const os of OSES) {
    if (os === platform) continue
    const dir = path.join(base, os)
    if (fs.existsSync(dir)) { fs.rmSync(dir, { recursive: true, force: true }); removed.push(os) }
  }
  return removed
}

function unpackedRootFor(context) {
  const p = context.electronPlatformName
  if (p === 'darwin') {
    const app = fs.readdirSync(context.appOutDir).find((n) => n.endsWith('.app'))
    return path.join(context.appOutDir, app, 'Contents', 'Resources', 'app.asar.unpacked')
  }
  return path.join(context.appOutDir, 'resources', 'app.asar.unpacked')
}

exports.default = async function afterPack(context) {
  const removed = trimUnpacked(unpackedRootFor(context), context.electronPlatformName)
  console.log(`  onnx-natives-trim: ${context.electronPlatformName} kept, removed [${removed.join(', ')}]`)
}
exports.trimUnpacked = trimUnpacked
