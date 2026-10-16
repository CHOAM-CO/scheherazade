// Runs before the engine's ESM graph. Cache forwarding to MCP is explicit.
const path = require('node:path')
const moduleApi = require('node:module')
const { bootBoundary } = require('./boot-progress.cjs')
bootBoundary('engine preload')
try {
  const result = moduleApi.enableCompileCache?.(process.env.DSH_SCHZ_COMPILE_CACHE)
  process.stderr.write(`[dsh-lane] boot compile cache status=${result?.status ?? 'unsupported'} pid=${process.pid}\n`)
} catch (error) {
  process.stderr.write(`[dsh-lane] boot compile cache unavailable: ${error.message}\n`)
}
// Do not leak the app cache to tool subprocesses, including on Windows.
for (const key of Object.keys(process.env)) {
  if (['NODE_COMPILE_CACHE', 'DSH_SCHZ_COMPILE_CACHE'].includes(key.toUpperCase())) delete process.env[key]
}
// The memory/channel marks belong to subprocesses, not the engine ESM graph.
// Log dispatch times without argv/env (which can contain credentials).
const cp = require('node:child_process')
const originalSpawn = cp.spawn
let remaining = Math.max(0, Number(process.env.DSH_SCHZ_BOOT_SPAWNS) || 0)
const timeoutMs = Math.min(30000, Math.max(1, Number(process.env.DSH_SCHZ_BOOT_HOOK_TIMEOUT_MS) || 30000))
delete process.env.DSH_SCHZ_BOOT_SPAWNS
delete process.env.DSH_SCHZ_BOOT_HOOK_TIMEOUT_MS
let restoreTimer
function restoreSpawn () {
  clearTimeout(restoreTimer)
  cp.spawn = originalSpawn
  moduleApi.syncBuiltinESMExports()
}
cp.spawn = function (command, args, ...rest) {
  if (--remaining <= 0) {
    restoreSpawn()
  }
  // Publish the engine's compiled SDK modules before a child imports them.
  try { moduleApi.flushCompileCache?.() } catch { /* Cache is optional. */ }
  bootBoundary(`child spawn executable=${path.basename(String(command))} entry=${path.basename(String(Array.isArray(args) ? args.find(arg => /\.(mjs|cjs|js)$/.test(arg)) || '' : ''))}`)
  return originalSpawn.call(this, command, args, ...rest)
}
if (!remaining) cp.spawn = originalSpawn
else {
  restoreTimer = setTimeout(restoreSpawn, timeoutMs)
  restoreTimer.unref()
}
moduleApi.syncBuiltinESMExports()
// Opt-in loader accounting, no NODE_DEBUG flood. Inclusive wall times are
// loader work only, not module evaluation; do not add them as startup totals.
if (process.env.SCHZ_BOOT_TRACE === '1' && moduleApi.registerHooks) {
  const totals = new Map()
  moduleApi.registerHooks({
    load(url, context, nextLoad) {
      const start = performance.now()
      try { return nextLoad(url, context) } finally {
        totals.set(url, (totals.get(url) || 0) + performance.now() - start)
      }
    }
  })
  const timer = setInterval(() => {
    const top = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 10)
    process.stderr.write(`[dsh-lane] boot loader top pid=${process.pid} ${JSON.stringify(top.map(([url, ms]) => ({ url, ms: Math.round(ms * 100) / 100 })))}\n`)
    totals.clear()
  }, 3000)
  timer.unref()
}
