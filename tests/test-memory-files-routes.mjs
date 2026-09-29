#!/usr/bin/env node
// test-memory-files-routes.mjs -- /api/agent-files/tree and /file (Memory page
// folder view, 0.3.8). The point of these routes is what they REFUSE:
// traversal, absolute paths, symlinks out of DATA_HOME, dot-folders,
// credential-looking names, non-text extensions. Drives the route table
// through a tiny real http server so status codes are the wire's.
//
// Run: node tests/test-memory-files-routes.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const { createRoutes, MAX_FILE_BYTES } = require_(path.join(ROOT, 'onboarding', 'routes', 'memory-files.cjs'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-memfiles-'))
const home = path.join(tmp, 'home')
const outside = path.join(tmp, 'outside')
const w = (rel, text, base = home) => {
  const p = path.join(base, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, text)
}
w('checkpoint.md', '# checkpoint\nhello')
w('journals/2026-09-01.md', 'old')
w('journals/2026-09-20.md', 'new')
w('journals/2026-09-10.md', 'mid')
w('session_notes/2026-09-20.md', 'note')
w('data.json', '{"a":1}')
w('notes.txt', 'plain')
w('big.md', 'x'.repeat(MAX_FILE_BYTES + 1000))
w('image.png', 'nope')
w('script.sh', 'nope')
w('.gates/file-ledger.json', '{}')
w('.claude/settings.json', '{}')
w('credentials/x.json', '{"k":1}')
w('auth-cache.json', '{}')
w('slack_token.txt', 'xoxb-secret')
w('.env', 'A=1')
w('bin/vendored/README.md', 'app-owned')
w('empty-dir/readme.png', 'x')
w('secret-outside.md', 'TOP SECRET', outside)
w('outside.md', 'LEAKED-CONTENT', outside)
fs.symlinkSync(path.join(outside, 'outside.md'), path.join(home, 'link-out.md'))
fs.symlinkSync(outside, path.join(home, 'link-dir'))
fs.symlinkSync(path.join(home, '.gates', 'file-ledger.json'), path.join(home, 'link-to-dot.json'))
fs.symlinkSync(path.join(home, 'credentials', 'x.json'), path.join(home, 'link-to-cred.json'))

const routes = createRoutes({
  fs, path, DATA_HOME: home,
  sendJson: (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) },
})
const srv = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname
  const r = routes.find((x) => x.method === req.method && x.match(pathname))
  if (!r) { res.writeHead(404); res.end('{}'); return }
  await r.handler(req, res, {}, r.match(pathname))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${srv.address().port}`

let pass = 0, fail = 0
const chk = (n, c, d) => { if (c) { pass++; console.log('  ok  ', n) } else { fail++; console.log('  FAIL', n, d === undefined ? '' : d) } }
const file = async (p) => {
  const r = await fetch(`${base}/api/agent-files/file?path=${encodeURIComponent(p)}`)
  return { status: r.status, body: await r.json() }
}

try {
  const tree = await (await fetch(`${base}/api/agent-files/tree`)).json()
  const flat = []
  const walk = (ns) => { for (const n of ns) { flat.push(n.path); if (n.children) walk(n.children) } }
  walk(tree.nodes)
  chk('tree lists checkpoint.md, journals/, session_notes/', ['checkpoint.md', 'journals', 'journals/2026-09-20.md', 'session_notes/2026-09-20.md', 'data.json', 'notes.txt'].every((p) => flat.includes(p)), flat.join(','))
  chk('tree hides dot-folders', !flat.some((p) => p.split('/').some((s) => s.startsWith('.'))), flat.join(','))
  chk('tree hides credential-looking names', !flat.some((p) => /credentials|auth-cache|token|\.env/.test(p)), flat.join(','))
  chk('tree hides non-text extensions and empty folders', !flat.some((p) => /png|\.sh|empty-dir|^bin/.test(p)), flat.join(','))
  chk('tree does not follow symlinks (file or dir)', !flat.some((p) => p.startsWith('link-')), flat.join(','))
  const j = tree.nodes.find((n) => n.name === 'journals')
  chk('date-named folder is newest first', j && j.children.map((c) => c.name).join() === '2026-09-20.md,2026-09-10.md,2026-09-01.md', j && j.children.map((c) => c.name).join())
  chk('root is the real DATA_HOME path', tree.root === fs.realpathSync(home), tree.root)

  let r = await file('checkpoint.md')
  chk('reads checkpoint.md', r.status === 200 && r.body.text.startsWith('# checkpoint') && r.body.truncated === false, JSON.stringify(r))
  r = await file('journals/2026-09-20.md')
  chk('reads nested file', r.status === 200 && r.body.text === 'new', JSON.stringify(r))
  r = await file('data.json')
  chk('reads .json', r.status === 200)
  r = await file('big.md')
  chk('oversize file is truncated with a flag', r.status === 200 && r.body.truncated === true && r.body.text.length === MAX_FILE_BYTES && r.body.size > MAX_FILE_BYTES, JSON.stringify({ s: r.status, t: r.body.truncated, l: (r.body.text || '').length }))

  // traversal / absolute
  for (const p of ['../outside/outside.md', '../../etc/passwd', 'journals/../../outside/outside.md', 'journals/..', '..\\outside\\outside.md', 'journals//x.md']) {
    r = await file(p)
    chk(`traversal refused: ${p}`, r.status === 400 || r.status === 403, r.status)
  }
  for (const p of ['/etc/passwd', path.join(outside, 'outside.md'), path.join(home, 'checkpoint.md'), 'C:\\Windows\\win.ini', '\\\\host\\share\\a.md']) {
    r = await file(p)
    chk(`absolute path refused: ${p}`, r.status === 400, r.status)
  }
  r = await file('')
  chk('empty path is 400', r.status === 400, r.status)
  r = await fetch(`${base}/api/agent-files/file`); chk('missing param is 400', r.status === 400, r.status)
  r = await file('a\0b.md'); chk('NUL byte refused', r.status === 400, r.status)

  // symlinks
  r = await file('link-out.md')
  chk('symlink to a file outside DATA_HOME is 403 (and leaks nothing)', r.status === 403 && !JSON.stringify(r.body).includes('LEAKED'), JSON.stringify(r))
  r = await file('link-dir/secret-outside.md')
  chk('file through a symlinked dir out of DATA_HOME is 403', r.status === 403 && !JSON.stringify(r.body).includes('SECRET'), JSON.stringify(r))
  r = await file('link-to-dot.json')
  chk('symlink laundering a dot-folder file is 403', r.status === 403, r.status)
  r = await file('link-to-cred.json')
  chk('symlink laundering a credential file is 403', r.status === 403, r.status)

  // allowlist
  for (const p of ['.gates/file-ledger.json', '.claude/settings.json', '.env', 'credentials/x.json', 'auth-cache.json', 'slack_token.txt', 'image.png', 'script.sh', 'bin/vendored/README.md']) {
    r = await file(p)
    chk(`allowlist refuses ${p}`, r.status === 403, r.status)
  }
  r = await file('nope.md'); chk('missing file is 404', r.status === 404, r.status)
  r = await file('journals'); chk('a directory is refused', r.status === 403 || r.status === 400, r.status)
  r = await file('journals/2026-09-01.md'); chk('sanity: allowed neighbour still reads', r.status === 200)
} finally {
  srv.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
