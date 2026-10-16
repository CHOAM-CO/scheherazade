import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const bootstrap = fileURLToPath(new URL('../engine-bootstrap.cjs', import.meta.url))
const result = spawnSync(process.execPath, ['--require', bootstrap, '--input-type=module', '-e', `
  import assert from 'node:assert/strict'
  import { spawn, spawnSync } from 'node:child_process'
  import cp from 'node:child_process'
  const wrapped = cp.spawn
  assert.equal(process.env.NODE_COMPILE_CACHE, undefined)
  assert.equal(process.env.DSH_SCHZ_COMPILE_CACHE, undefined)
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  assert.notEqual(cp.spawn, wrapped)
  assert.equal(spawn, cp.spawn, 'ESM spawn binding restored')
  const second = spawn(process.execPath, ['-e', 'process.exit(0)'])
  const tool = spawnSync(process.execPath, ['-p', 'String(process.env.NODE_COMPILE_CACHE)'], { encoding: 'utf8' })
  assert.equal(tool.stdout.trim(), 'undefined')
  await Promise.all([child, second].map(c => new Promise(resolve => c.on('exit', code => { assert.equal(code, 0); resolve() }))))
`], { encoding: 'utf8', env: { ...process.env, DSH_SCHZ_BOOT_SPAWNS: '1', DSH_SCHZ_COMPILE_CACHE: '/unused-test-cache', NODE_COMPILE_CACHE: '/unused-test-cache', NODE_DISABLE_COMPILE_CACHE: '1' } })
assert.equal(result.status, 0, result.stderr)
assert.match(result.stderr, /boot engine preload elapsed_ms=\d+ pid=\d+ process_ms=\d+/)
assert.match(result.stderr, /boot compile cache status=/)
assert.equal((result.stderr.match(/boot child spawn executable=/g) || []).length, 1)
console.log('engine bootstrap: cache isolation, bounded logging and restored CJS/ESM spawn PASS')

const timeoutResult = spawnSync(process.execPath, ['--require', bootstrap, '--input-type=module', '-e', `
  import assert from 'node:assert/strict'
  import cp, { spawn } from 'node:child_process'
  const wrapped = cp.spawn
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.notEqual(cp.spawn, wrapped, 'timeout restores hook with no spawns')
  assert.equal(spawn, cp.spawn)
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise(resolve => child.on('exit', code => { assert.equal(code, 0); resolve() }))
`], { encoding: 'utf8', env: { ...process.env, DSH_SCHZ_BOOT_SPAWNS: '999', DSH_SCHZ_BOOT_HOOK_TIMEOUT_MS: '10', NODE_DISABLE_COMPILE_CACHE: '1' } })
assert.equal(timeoutResult.status, 0, timeoutResult.stderr)
assert.doesNotMatch(timeoutResult.stderr, /boot child spawn/)
console.log('engine bootstrap: unused spawn budget timeout restoration PASS')
