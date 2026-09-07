#!/usr/bin/env node
// assert-platform.mjs -- hard gate in front of every `npm run dist*` lane.
// Usage: node tools/assert-platform.mjs <mac|win|linux>
//
// WHY (the defect this exists to make impossible). build.asarUnpack ships
// "node_modules/**" -- the LOCAL tree, verbatim, with no per-target native
// selection by electron-builder. The Electron shell itself cross-builds fine
// (electron-builder downloads the target's Electron), so a wrong-host build
// LOOKS like it worked: it produces a correctly named artifact of the right
// size, and every native inside it belongs to the build host instead of the
// target.
//
// That is not hypothetical. `Scheherazade-0.2.20-x86_64.AppImage` was built on
// this arm64 Mac on 2026-09-06 and published as the v0.2.20 Linux asset. `file`
// on its AppRun says ELF aarch64 -- an "x86_64"-named binary that no x86_64
// Linux can execute at all -- and its app.asar.unpacked/node_modules carried
// @koromix/koffi-darwin-arm64, @img/sharp-darwin-arm64 and
// @vscode/ripgrep-darwin-arm64 and none of the linux counterparts. Nothing
// stopped it, because only `dist:win` had a host assert (scripts/assert-win32.mjs,
// which this file replaces). It was replaced on 2026-09-07 by a native WSL x64
// build (193,664,187 B).
//
// So: one gate, three targets, arch included. The arch half is not decoration --
// the mac lane builds arm64 dmgs and the linux/win lanes build x64, and an
// x64-mac or arm64-WSL host would reproduce the same class one level down
// (right OS, wrong natives, honest-looking name).
//
// This gate does NOT relax when node-pty goes away. node-pty was never the only
// native: dsh brings koffi, sharp + libvips, @vscode/ripgrep, landlock-run and
// its own nested node-pty, all of which are per-platform prebuilds shipped
// verbatim by asarUnpack. tools/test-packaging.mjs's NATIVES gate is the
// second half of this pair (it checks what a bundle actually contains); this
// half stops the wrong host from producing one in the first place.

const TARGETS = {
  mac: { platform: 'darwin', arch: 'arm64', script: 'dist / dist:mac', host: 'this Mac (magi-mac)' },
  win: { platform: 'win32', arch: 'x64', script: 'dist:win', host: 'the Windows box (magi-win)' },
  linux: { platform: 'linux', arch: 'x64', script: 'dist:linux', host: 'WSL2 x64 on magi-win (/root/schz)' },
}

const [, , target] = process.argv
const spec = Object.prototype.hasOwnProperty.call(TARGETS, target) ? TARGETS[target] : null

if (!spec) {
  console.error(
    `assert-platform: unknown target ${JSON.stringify(target === undefined ? null : target)} -- ` +
    `expected one of ${Object.keys(TARGETS).join(' | ')}. ` +
    'Usage: node tools/assert-platform.mjs <mac|win|linux>',
  )
  process.exit(2)
}

const hostPlatform = process.platform
const hostArch = process.arch
const okPlatform = hostPlatform === spec.platform
const okArch = hostArch === spec.arch

if (!okPlatform || !okArch) {
  // ONE line, and it names the defect class rather than the rule. "wrong
  // platform" tells nobody what breaks; "a mac-built x86_64 AppImage is an
  // aarch64 ELF carrying darwin natives" is the thing that already shipped.
  const wrong = !okPlatform ? 'platform' : 'architecture'
  console.error(
    `${spec.script} must run on ${spec.platform}/${spec.arch} (this host is ${hostPlatform}/${hostArch}) -- ` +
    `wrong ${wrong}: build.asarUnpack ships THIS host's node_modules verbatim, so the artifact would carry ` +
    `${hostPlatform}-${hostArch} natives (koffi / sharp / ripgrep / landlock) under a ${spec.platform}-${spec.arch} name, ` +
    `the class that shipped the mac-built "x86_64" 0.2.20 AppImage (an aarch64 ELF with darwin natives). ` +
    `Build on ${spec.host}.`,
  )
  process.exit(1)
}
