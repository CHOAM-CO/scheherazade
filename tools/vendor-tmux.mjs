#!/usr/bin/env node
// vendor-tmux.mjs — build-time vendoring of a portable tmux (Task: 극한의
// 딸깍; Mino 07-30 "brew로 깔아야돼? 이거 귀찮은데").
// Run: node tools/vendor-tmux.mjs   (needs a brew tmux on the build machine)
//
// Produces vendor/tmux-portable/ :
//   tmux            — brew binary with its three Homebrew dylib load paths
//                     rewritten to @executable_path/lib/<name>
//   lib/<3 dylibs>  — utf8proc / ncursesw / libevent_core, install ids
//                     rewritten to match (none of the three cross-depends on
//                     another; each links only itself + libSystem — verified
//                     07-30, so three -change calls on the binary is the
//                     whole graph)
//   VERSION         — `tmux -V` output; the boot-time sync stamp
//
// install_name_tool invalidates the signature and arm64 macOS refuses to
// exec unsigned binaries, so every rewritten file is ad-hoc re-signed
// (codesign -s -), same identity class the app itself ships with.
//
// The vendored tree is COMMITTED and shipped via extraResources to
// Contents/Resources/tmux-portable, then copied by harness-render into
// DATA_HOME/bin/tmux-portable at boot. Copied OUT of the bundle on purpose:
// the attach topology's entire point is that the tmux server's TCC
// attribution descends from the USER'S TERMINAL (probe-0016), and probe-0016
// never tested whether exec'ing a binary that lives INSIDE Scheherazade.app
// re-keys attribution to the app bundle. A binary in DATA_HOME makes the
// question moot instead of betting the topology on an unverified answer.
//
// Verification here is functional, not just structural: after the rewrite
// the script boots a real server on a throwaway socket with a brew-less
// PATH, round-trips has-session, and kills it.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'vendor', 'tmux-portable')
const LIB = path.join(OUT, 'lib')

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, { encoding: 'utf8', ...opts })
}

const SRC_TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux'].find((p) => fs.existsSync(p))
if (!SRC_TMUX) {
  console.error('no brew tmux found to vendor (looked in /opt/homebrew/bin, /usr/local/bin)')
  process.exit(1)
}

// Parse the binary's actual load commands rather than hardcoding versioned
// paths -- a brew upgrade renames libevent_core-2.1.7 and a hardcode rots.
const loads = run('otool', ['-L', SRC_TMUX])
  .split('\n').slice(1)
  .map((l) => l.trim().split(' ')[0])
  .filter((p) => p.startsWith('/opt/homebrew/') || p.startsWith('/usr/local/'))
if (loads.length === 0) {
  console.error(`${SRC_TMUX} has no Homebrew dylib deps -- nothing to vendor (already static?)`)
  process.exit(1)
}

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(LIB, { recursive: true })

const dstTmux = path.join(OUT, 'tmux')
fs.copyFileSync(SRC_TMUX, dstTmux)
fs.chmodSync(dstTmux, 0o755)

for (const dep of loads) {
  const name = path.basename(dep)
  const dst = path.join(LIB, name)
  fs.copyFileSync(fs.realpathSync(dep), dst)
  fs.chmodSync(dst, 0o644)
  run('install_name_tool', ['-id', `@executable_path/lib/${name}`, dst])
  run('install_name_tool', ['-change', dep, `@executable_path/lib/${name}`, dstTmux])
  run('codesign', ['--force', '-s', '-', dst])
  console.log(`vendored ${name}`)
}
run('codesign', ['--force', '-s', '-', dstTmux])

// ── verify: structure ─────────────────────────────────────────────────────
const after = run('otool', ['-L', dstTmux])
if (/\/opt\/homebrew\/|\/usr\/local\//.test(after)) {
  console.error('REWRITE INCOMPLETE -- brew paths survive in the binary:\n' + after)
  process.exit(1)
}
run('codesign', ['--verify', dstTmux])

// ── verify: function, on a brew-less PATH ─────────────────────────────────
const cleanEnv = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: process.env.HOME,
  TERM: 'xterm-256color',
  TERMINFO_DIRS: '/usr/share/terminfo',
}
const version = run(dstTmux, ['-V'], { env: cleanEnv }).trim()
const SOCK = `vendor-smoke-${process.pid}`
try {
  run(dstTmux, ['-L', SOCK, 'new-session', '-d', '-s', 'smoke', 'sleep 30'], { env: cleanEnv })
  run(dstTmux, ['-L', SOCK, 'has-session', '-t', 'smoke'], { env: cleanEnv })
  console.log(`smoke: server boot + has-session OK on throwaway socket (${SOCK})`)
} finally {
  try { run(dstTmux, ['-L', SOCK, 'kill-server'], { env: cleanEnv }) } catch { /* already gone */ }
}

fs.writeFileSync(path.join(OUT, 'VERSION'), version + '\n')
console.log(`\nvendored ${version} -> ${OUT}`)
