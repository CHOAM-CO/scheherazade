'use strict'
// onboarding/platform.cjs -- ONE capability table for mac, Windows and Linux.
//
// design-0023 P4. Before this file `onboarding/` decided what the host can do
// in 24 separate places, and EVERY ONE of them was a binary mac-vs-Windows
// test (`process.platform === 'darwin'`, `!== 'win32'`). Linux was never a
// row: it silently inherited whichever else-branch it landed in, which is how
// a Linux user got offered "Install automatically" for codex and received an
// `aarch64-apple-darwin` tarball, then `이 빌드는 Apple Silicon 전용입니다`
// (read-C §2 G1). Every one of those 24 sites is a lookup here now, so adding
// a platform is editing ONE table instead of grepping for a comparison
// operator.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a capability is false until a
// platform is NAMED as having it. No `else` arm ever grants anything. If a
// row below reads `platform === 'darwin'`, Linux gets false -- deliberately,
// visibly, and with the same sentence the UI shows the user.
//
// INJECTABLE: every input (platform, arch, env, homedir, dataHome, existsSync,
// hasTmux) is a parameter, so tests/test-platform.mjs drives all three
// platforms x both arches from one host. Nothing here reads process.platform
// except the zero-argument default.
//
// NOT here, on purpose:
//   - process control (killTree/gracefulStop/resolveOnPath) -- that is
//     proc.cjs (P3), re-exported below so callers need one require, not two.
//   - the data directory -- data-home.cjs (P3).
//   - window construction options -- window-glass.cjs owns the BrowserWindow
//     shape; `windowMaterial` here names which Electron API the LIVE
//     appearance apply must call, which is a different question.
//   - user-facing words. copy.js owns the browser's strings; the few names
//     below (shellName/credStoreName/machineWord) exist because the SERVER
//     also has to write sentences (the safeStorage refusal, the uninstall
//     501-replacement) and those must not disagree with the page.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, execFile } = require('node:child_process')

const proc = require('../proc.cjs')
const { resolveDataHome } = require('../data-home.cjs')

const PLATFORMS = ['darwin', 'win32', 'linux']

// ── skills that are not portable ─────────────────────────────────────────
// Which host FACT each seeded skill needs. harness-render.cjs filters the
// template dir through this (P4 deliverable 7): a Windows agent used to be
// handed `calendar` (osascript + macOS Calendar.app), `mail-briefing`,
// `reminders` and `file-organizer` (unix find/mv) and told to use them.
// A skill with no entry is portable and always seeds.
const SKILL_REQUIREMENTS = Object.freeze({
  calendar: 'appleApps',
  'mail-briefing': 'appleApps',
  reminders: 'appleApps',
  'file-organizer': 'unixTools',
  windowshot: 'windowCapture',
})

// Fixed candidate DIRECTORIES per platform, in resolution order.
//
// FIXED ABSOLUTE LOCATIONS ONLY -- there is deliberately NO PATH walk here.
// That posture is inherited verbatim from http-server.cjs's security review
// ("a poisoned launch PATH must never pick the binary; logging does not
// mitigate execution", and a Finder/launchd-started app has a minimal PATH
// anyway). The Linux gap this closes is not "PATH was not searched", it is
// that /usr/bin, ~/.local/bin, /snap/bin and the npm global prefix were NOT
// ON THE FIXED LIST -- so `codex login` reported cli_missing on apt, npm and
// snap installs, which is every ordinary Linux install (read-C §2 G1).
// proc.resolveOnPath stays available for callers that genuinely want PATH
// (spawnBin takes `allowPath` and no onboarding call site passes it).
function binDirsFor({ platform, env, home, dataHome }) {
  const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
  if (platform === 'win32') {
    return [
      path.join(dataHome, 'bin'), // app-managed bootstrap dir
      path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'), // OpenAI's own installer
      path.join(appData, 'npm'), // npm global (.cmd shims -- see spawnBin)
      path.join(localAppData, 'Programs', 'Ollama'),
    ]
  }
  if (platform === 'linux') {
    // npm's global prefix is configurable; npm_config_prefix is what npm
    // itself exports, and the two ~/.npm-* spellings are what the common
    // "don't sudo npm -g" guides tell people to set it to. Reading the real
    // prefix would mean spawning npm on a status poll -- no.
    const npmPrefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || null
    return [
      path.join(dataHome, 'bin'),
      path.join(home, '.local', 'bin'), // claude.ai/install.sh, pipx, pip --user
      '/usr/local/bin',
      '/usr/bin',
      ...(npmPrefix ? [path.join(npmPrefix, 'bin')] : []),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.npm-packages', 'bin'),
      '/snap/bin',
      path.join(home, '.cargo', 'bin'),
    ]
  }
  // darwin
  return [
    path.join(dataHome, 'bin'),
    '/opt/homebrew/bin', // brew, Apple Silicon
    '/usr/local/bin', // brew, Intel + historical
    path.join(home, '.local', 'bin'), // claude.ai/install.sh's own default
  ]
}

// Executable file names to try for one bare bin name. On Windows a bare
// `codex` is not executable -- `codex.exe` / `codex.cmd` is -- and PATHEXT is
// where the OS keeps that list (upper-case by convention, lower-case on
// disk, so both spellings are tried; same rule proc.resolveOnPath uses).
function binNamesFor(name, { platform, env }) {
  if (platform !== 'win32') return [name]
  const exts = String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  const out = []
  for (const ext of exts) out.push(name + ext.toLowerCase(), name + ext)
  out.push(name) // a real extension-less file, e.g. inside WSL-ish setups
  return [...new Set(out)]
}

/**
 * The whole table. One call, one frozen descriptor.
 *
 * Every argument is injectable so a Linux row can be asserted from a Mac.
 * `existsSync` and `hasTmux` are the only host reads; both have honest
 * defaults and both are replaced wholesale by tests.
 */
function capabilities({
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  home = null,
  dataHome = null,
  existsSync = fs.existsSync,
  accessSync = fs.accessSync,
  hasTmux = null,
  spawnImpl = spawn,
  execFileImpl = execFile,
} = {}) {
  const homeDir = home || os.homedir()
  const data = dataHome || resolveDataHome({ env, home: homeDir, allowMem: false })
  const isMac = platform === 'darwin'
  const isWin = platform === 'win32'
  const isLinux = platform === 'linux'

  const binDirs = binDirsFor({ platform, env, home: homeDir, dataHome: data })

  function binCandidates(name) {
    const names = binNamesFor(name, { platform, env })
    const out = []
    for (const dir of binDirs) for (const n of names) out.push(path.join(dir, n))
    return out
  }

  // First candidate that exists AND is executable. X_OK is meaningless on
  // Windows (it answers for every readable file), which is exactly why the
  // extension list above does the discriminating there.
  function resolveBin(name, { allowPath = false } = {}) {
    for (const candidate of binCandidates(name)) {
      try {
        accessSync(candidate, fs.constants.X_OK)
        return candidate
      } catch { /* not here, keep looking */ }
    }
    // Opt-in only, and nothing in onboarding/ opts in -- see binDirsFor's
    // header for why PATH is not a trusted input in this process.
    if (allowPath) return proc.resolveOnPath(name, { env, platform, existsSync })
    return null
  }

  // ONE owner of the spawn shape. Before this there were five hand-copies of
  // "does it end in .cmd?" and three of "attach an 'error' listener", and the
  // two MCP call sites had NEITHER -- so an npm-shim `claude` was an EINVAL
  // on current Node and a spawn failure was an unhandled 'error' event, which
  // main.cjs's uncaughtException handler escalates to app.exit(1) (the exact
  // way the Windows uninstall used to make the app vanish mid-run).
  //
  // The three rules, all of them platform facts rather than preferences:
  //   1. .cmd/.bat cannot be exec'd by CreateProcess -- they need a shell.
  //   2. `detached` and `shell:true` are incompatible on Windows (the shell
  //      becomes the group leader and the real child escapes the kill), so
  //      detached is dropped exactly where the shell is needed. killTree's
  //      taskkill /T still reaps the tree through cmd.exe.
  //   3. windowsHide keeps a console window from flashing on every spawn.
  // `onError` is REQUIRED-by-default: a caller that passes none gets a
  // logged handler, never an unhandled 'error' event.
  function spawnBin(bin, args = [], opts = {}) {
    const {
      detached = false, onError = null, allowPath = false, ...rest
    } = opts
    const resolved = bin && (bin.includes('/') || bin.includes('\\')) ? bin : resolveBin(bin, { allowPath })
    if (!resolved) {
      const err = new Error(`spawnBin: no executable found for ${JSON.stringify(bin)} on ${platform}`)
      err.code = 'ENOENT'
      throw err
    }
    const needsShell = /\.(cmd|bat)$/i.test(resolved)
    const child = spawnImpl(resolved, args, {
      ...rest,
      shell: needsShell,
      detached: detached && !needsShell,
      windowsHide: true,
    })
    child.on('error', (err) => {
      if (onError) onError(err)
      else console.error(`[scheherazade/platform] spawn ${resolved} failed: ${err.message}`)
    })
    child.spawnPath = resolved
    child.usedShell = needsShell
    return child
  }

  // execFile with the same .cmd rule. `claude mcp list` on an npm shim used
  // to be an EINVAL here for want of these three lines.
  function execFileBin(bin, args, options, callback) {
    const resolved = bin && (bin.includes('/') || bin.includes('\\')) ? bin : resolveBin(bin)
    if (!resolved) {
      const err = new Error(`execFileBin: no executable found for ${JSON.stringify(bin)} on ${platform}`)
      err.code = 'ENOENT'
      process.nextTick(() => callback(err, '', ''))
      return null
    }
    const opts = { ...(options || {}), windowsHide: true }
    if (/\.(cmd|bat)$/i.test(resolved)) opts.shell = true
    return execFileImpl(resolved, args, opts, callback)
  }

  const tmuxProbe = hasTmux || (() => {
    if (existsSync(path.join(data, 'bin', 'tmux-portable', 'tmux'))) return true
    return Boolean(proc.resolveOnPath('tmux', { env, platform, existsSync }))
  })

  const table = {
    id: platform,
    arch,
    isMac,
    isWin,
    isLinux,

    // ── install / uninstall ────────────────────────────────────────────
    // Managed dependency install (codex tarball + Ollama.dmg). darwin AND
    // arm64: bootstrap.cjs downloads codex-aarch64-apple-darwin and mounts a
    // DMG with /usr/bin/hdiutil. It used to be `!== 'win32'`, so an Intel Mac
    // and every Linux box were offered the button and then told, in Korean,
    // that the build is Apple-Silicon-only (read-C R2).
    managedInstall: isMac && arch === 'arm64',
    // The Claude CLI's own installer is `curl -fsSL https://claude.ai/install.sh | bash`
    // -- a POSIX shell script that drops a binary in ~/.local/bin. It is real
    // on Linux (that is upstream's supported path there); Windows has a
    // separate PowerShell one-liner we do not run for the user.
    claudeCliInstall: isMac || isLinux ? 'curl-bash' : false,
    // How the app can remove ITSELF. Three genuinely different mechanisms,
    // so this is a mode string, not a boolean:
    //   'bundle-trash' -- rm -rf the residue, then shell.trashItem the .app
    //   'nsis'         -- run the NSIS uninstaller electron-builder wrote
    //   'script'       -- rm -rf the residue and unlink $APPIMAGE
    inAppUninstall: isMac ? 'bundle-trash' : isWin ? 'nsis' : 'script',

    // ── OS surfaces ────────────────────────────────────────────────────
    // The permissions checklist is macOS TCC end to end (FDA, Screen
    // Recording, Accessibility, Automation, SIP). Windows and Linux have no
    // equivalent wall map, so the panel is hidden rather than filled with
    // 'indeterminate' rows nobody can act on.
    permissionsPanel: isMac,
    // Does this platform have an attach lane AT ALL? Only mac: the vendored
    // Mach-O tmux ships via build.mac.extraResources and the bootstrap is a
    // bash script whose TCC-attribution reasoning is macOS-specific. This is
    // the flag the harness ARTIFACT decision uses (render attach-bootstrap.sh
    // or not) -- deliberately NOT the probe below, because renderHarnessFiles
    // runs BEFORE syncTmuxPortable on every boot, so a probe here would skip
    // the file for the whole of a fresh install's first session.
    attachLane: isMac,
    // `sudo` exists on mac and Linux; Windows elevation is UAC and the
    // askpass helper is a bash script. Storing an "admin password" on
    // Windows stored a secret nothing could ever consume.
    sudo: isMac || isLinux,
    // Which Electron API the live appearance apply must call.
    // 'vibrancy' = win.setVibrancy(material); 'acrylic' = win.setBackgroundMaterial();
    // 'none' = there is no compositor API to call, and the UI must SAY so
    // instead of saving a setting that does nothing.
    windowMaterial: isMac ? 'vibrancy' : isWin ? 'acrylic' : 'none',
    // The calendar MCP server is osascript + macOS Calendar.app all the way
    // down. Registering it elsewhere hands the agent a tool that can only fail.
    calendarMcp: isMac,
    // Where the Claude CLI keeps the login this app reuses: the login
    // keychain on mac (metadata probe only), ~/.claude/.credentials.json
    // everywhere else.
    cliCredentialKeychain: isMac,
    // Apple-app automation (osascript / System Events). Gates the seeded
    // skills and the "Controlling the Mac" system-prompt section.
    appleApps: isMac,
    // A POSIX shell + find/mv/sed. The rendered helpers (attach-bootstrap.sh,
    // sudo-askpass.sh) and the file-organizer skill are bash top to bottom;
    // on Windows they were written, chmod'd (a no-op) and inert.
    unixTools: !isWin,
    // Does chmod mean anything here? The 0700/0755 asserts in the suite are
    // gated on exactly this fact today, in nine separate hand-written ifs.
    execBit: !isWin,
    // Window capture: mac = osascript + screencapture, win = PrintWindow.
    // Linux would need xdotool + import and has no Wayland answer at all.
    windowCapture: isMac || isWin,

    // ── words the SERVER has to write ──────────────────────────────────
    shellName: isWin ? 'PowerShell' : 'Terminal',
    machineWord: isMac ? 'this Mac' : isWin ? 'this PC' : 'this computer',
    credStoreName: isMac
      ? 'macOS Keychain'
      : isWin
        ? 'Windows DPAPI'
        : 'the OS keyring (gnome-keyring / kwallet)',

    // ── binaries ───────────────────────────────────────────────────────
    binDirs,
    binCandidates,
    resolveBin,
    spawnBin,
    execFileBin,
    killTree: proc.killTree,
    resolveOnPath: (name) => proc.resolveOnPath(name, { env, platform, existsSync }),

    // ── seeded skills ──────────────────────────────────────────────────
    SKILL_REQUIREMENTS,
  }

  // The attach lane needs a tmux, so this row is a PROBE, not a constant --
  // and a LAZY one. The vendored Mach-O tmux (build.mac.extraResources, mac
  // only) is copied into DATA_HOME/bin by syncTmuxPortable at boot, which
  // happens AFTER this module is first required; a value computed at require
  // time would answer false for the whole of a fresh install's first session
  // and hide the topology card on the one platform that has it.
  Object.defineProperty(table, 'attachTopology', {
    enumerable: true,
    get: () => table.attachLane && tmuxProbe(),
  })

  // Derived, so no caller re-derives it differently.
  table.supportsBlur = table.windowMaterial !== 'none'
  table.skillAllowed = (name) => {
    const need = SKILL_REQUIREMENTS[name]
    return need ? Boolean(table[need]) : true
  }

  // The JSON the renderer gets: booleans, strings and the arch, never a
  // function and never an absolute path (binDirs names the user's home).
  // ONE shape, served twice -- <meta name="host-capabilities"> for first
  // paint and GET /api/config for everything after it -- so the page cannot
  // read one answer before its first fetch and a different one after.
  table.clientView = () => ({
    id: table.id,
    arch: table.arch,
    managedInstall: table.managedInstall,
    claudeCliInstall: table.claudeCliInstall,
    inAppUninstall: table.inAppUninstall,
    permissionsPanel: table.permissionsPanel,
    attachTopology: table.attachTopology,
    sudo: table.sudo,
    windowMaterial: table.windowMaterial,
    supportsBlur: table.supportsBlur,
    calendarMcp: table.calendarMcp,
    windowCapture: table.windowCapture,
    shellName: table.shellName,
    machineWord: table.machineWord,
    credStoreName: table.credStoreName,
  })

  return Object.freeze(table)
}

// The host's own table. Built once (the binDirs list and the tmux probe are
// the only host reads and neither changes under a running app) and used by
// every module that does not need injection.
let hostCache = null
function host() {
  if (!hostCache) hostCache = capabilities()
  return hostCache
}
// Tests that mutate process.platform around a call need the cache gone.
function resetHostCache() { hostCache = null }

module.exports = {
  PLATFORMS,
  SKILL_REQUIREMENTS,
  capabilities,
  host,
  resetHostCache,
  binDirsFor,
  binNamesFor,
}
