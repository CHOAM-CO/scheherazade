import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { compareVersions, isNewerVersion, fetchLatestRelease } = require('../onboarding/update-version.cjs')
for (const [a, b, result] of [
  ['0.5.0-beta.6', '0.5.0-beta.5', 1], ['0.5.0', '0.5.0-beta.5', 1],
  ['0.5.1', '0.5.0-beta.5', 1], ['0.5.0-beta.5', '0.5.0-beta.5', 0],
  ['1.0.0+one', '1.0.0+two', 0], ['v1.0.0', '1.0.0', 0],
  ['1.0.0-beta.10', '1.0.0-beta.9', 1], ['1.0.0-99999999999999999999', '1.0.0-99999999999999999998', 1],
]) { assert.equal(compareVersions(a, b), result); assert.equal(compareVersions(b, a), result ? -result : 0) }
const order = ['alpha', 'alpha.1', 'alpha.beta', 'beta', 'beta.2', 'beta.11', 'rc.1'].map(p => `1.0.0-${p}`).concat('1.0.0')
for (let i = 1; i < order.length; i++) assert.ok(isNewerVersion(order[i], order[i - 1]))
for (const bad of ['1.0.0junk', '01.0.0', '1.0.0-01', '1.0.0-', '1.0.0+']) assert.equal(compareVersions(bad, '1.0.0'), null)
let url
const fetchImpl = async u => { url = u; return { ok: true, json: async () => u.includes('/latest') ? { tag_name: 'v0.4.0' } : [
  { tag_name: 'v0.5.0-beta.5', prerelease: true }, { tag_name: 'v0.5.0-beta.6', prerelease: true },
  { tag_name: 'v9.0.0', draft: true }, { tag_name: 'garbage' }, { tag_name: 'v0.4.0' },
] } }
assert.equal((await fetchLatestRelease({ repo: 'owner/repo', current: '0.5.0-beta.5', fetchImpl })).tag_name, 'v0.5.0-beta.6')
assert.ok(url.endsWith('/releases?per_page=100'))
assert.equal((await fetchLatestRelease({ repo: 'owner/repo', current: '0.4.0', fetchImpl })).tag_name, 'v0.4.0')
assert.ok(url.endsWith('/releases/latest'))
assert.equal((await fetchLatestRelease({ repo: 'owner/repo', current: '0.5.0-beta.5', fetchImpl: async () => ({ ok: true, json: async () => [{ tag_name: '0.5.0-beta.6' }, { tag_name: '0.5.0' }] }) })).tag_name, '0.5.0')
console.log('SemVer precedence and stable/beta feed tests passed')
