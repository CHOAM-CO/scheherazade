// Shared strict SemVer precedence and GitHub feed selection. No Electron dependency.
function parseSemver(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.trim().replace(/^v/i, '').match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/)
  if (!m) return null
  const pre = m[4] ? m[4].split('.') : []
  if (pre.some(p => /^\d+$/.test(p) && p.length > 1 && p[0] === '0')) return null
  return { core: m.slice(1, 4), pre }
}
function compareVersions(a, b) {
  const x = parseSemver(a), y = parseSemver(b)
  if (!x || !y) return null
  const cmp = (a, b) => a === b ? 0 : a > b ? 1 : -1
  for (let i = 0; i < 3; i++) {
    const n = cmp(BigInt(x.core[i]), BigInt(y.core[i]))
    if (n) return n
  }
  if (!x.pre.length || !y.pre.length) return cmp(!x.pre.length, !y.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (i === x.pre.length) return -1
    if (i === y.pre.length) return 1
    const a = x.pre[i], b = y.pre[i]
    if (a === b) continue
    const an = /^\d+$/.test(a), bn = /^\d+$/.test(b)
    return an && bn ? cmp(BigInt(a), BigInt(b)) : an !== bn ? (an ? -1 : 1) : cmp(a, b)
  }
  return 0
}
const isNewerVersion = (remote, local) => compareVersions(remote, local) === 1
const isPrerelease = version => !!parseSemver(version)?.pre.length
async function fetchLatestRelease({ repo, current, fetchImpl = fetch }) {
  const beta = isPrerelease(current)
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases${beta ? '?per_page=100' : '/latest'}`, {
    headers: { 'user-agent': 'scheherazade-updater', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`)
  const body = await res.json()
  const releases = beta ? body : [body]
  if (!Array.isArray(releases)) throw new Error('releases API returned an invalid release list')
  const candidates = releases.filter(r => r && !r.draft && parseSemver(r.tag_name) && (beta || (!r.prerelease && !isPrerelease(r.tag_name))))
  candidates.sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  if (!candidates.length) throw new Error('releases API returned no usable release')
  return candidates[0]
}
module.exports = { parseSemver, compareVersions, isNewerVersion, isPrerelease, fetchLatestRelease }
