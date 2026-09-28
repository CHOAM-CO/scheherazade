// onboarding/routes/settings.cjs -- settings-persistence routes (group 9)
// (issue #9 PR-2 route grouping).
//
// Route BODIES ONLY, moved verbatim (comments included) from
// onboarding/http-server.cjs's old handleApi if-chain. Helper functions,
// constants, and mutable singletons STAY in http-server.cjs with exactly one
// owner; this file binds what its bodies need ONCE from staticCtx (one
// destructuring statement, below). Per-call values -- agentControls,
// onOnboardingComplete, the live askpassToken getter -- arrive via callCtx
// on every request (see http-server.cjs handleApi). The returned array's
// order IS the dispatch order and preserves the old chain's intra-group
// order exactly.
'use strict'

const os = require('node:os')
const nodePath = require('node:path')
const { spawn } = require('node:child_process')
const agentIdentity = require('../agent-identity.cjs')
const { POWERSHELL_EXE } = require('../../proc.cjs')

// ── clean uninstall plan (v0.0.35, Task: 클린테스트 in-app) ────────────────
// Exported separately so tests/test-uninstall-plan.mjs can attack the plan
// without an Electron process: WHAT gets deleted is the security-sensitive
// part, and it must be pinned as data, not read out of a shell string.
//
// The four residue classes (07-30 manual paste block, now productized):
//   1. DATA_HOME -- the agent itself: memory, journals, config, credentials'
//      encrypted blobs, the synced tmux-portable
//   2. Electron per-app Library dirs (userData/caches/prefs/saved state/logs)
//   3. the Keychain "Safe Storage" entry (the key the blobs were sealed with)
//   4. ~/.claude/projects/<slug of DATA_HOME> -- the CLI's transcripts for
//      OUR workspace only
// NEVER on the list: ~/.claude.json (merge-only, three first-run flags the
// user's own Claude Code shares) and ~/.claude itself. Deleting those breaks
// the user's personal Claude Code to clean up after ours -- the one line the
// 07-30 uninstall guide drew in bold, kept here as a tested invariant.
// design-0023 P4 deliverable 5: three plans, one shape. Until now this was a
// macOS script and a 501 -- `/api/uninstall` answered `unsupported_platform`
// on Windows and Linux while settings.js rendered the button on every
// platform, so the whole feature was an error toast off mac (read-C G9). The
// residue classes are the same three questions everywhere ("the agent", "the
// Electron per-app dirs", "the CLI's transcripts for OUR workspace"); only
// the ANSWERS and the interpreter differ.
//
// `dirs` stays DATA on every platform -- tests/test-uninstall-plan.mjs
// asserts the protected-path invariants against the array, never by reading
// shell text, and those invariants (~/.claude and ~/.claude.json are NEVER on
// the list; only OUR projects slug, never its parent) are platform-independent.
//
// The Electron per-app locations, from Electron's own app.getPath table:
//   darwin -- ~/Library/{Application Support,Caches,Preferences,Logs,Saved Application State}
//   win32  -- %APPDATA%\<name> (userData) and %LOCALAPPDATA%\<name> (Chromium cache)
//   linux  -- $XDG_CONFIG_HOME|~/.config/<name> and $XDG_CACHE_HOME|~/.cache/<name>
const PRODUCT = 'Scheherazade'

// The Claude CLI's per-workspace transcript dir name. It munges the absolute
// workspace path into one segment; on POSIX that is '/'->'-', on Windows the
// drive colon and the backslashes go the same way ('C:\Users\x' ->
// 'C--Users-x'), which is why this is a table and not one replaceAll.
function projectSlug(dataHome, platform) {
  return platform === 'win32'
    ? String(dataHome).replace(/[\\/:]/g, '-')
    : String(dataHome).replaceAll('/', '-')
}

// The path flavour is chosen by the TARGET platform, not by the host running
// this code. nodePath is win32 on Windows and posix elsewhere, so a plan
// built for one platform on another came out with mixed separators
// ('C:\\Users\\t/AppData/Roaming/...'), which is unrunnable AND untestable --
// and untestable is how the Windows lane stayed a 501 for a year.
const pathFor = (platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix)

function residueDirs(dataHome, home, platform, env) {
  const J = pathFor(platform)
  const slug = J.join(home, '.claude', 'projects', projectSlug(dataHome, platform))
  if (platform === 'win32') {
    const appData = env.APPDATA || J.join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA || J.join(home, 'AppData', 'Local')
    return [dataHome, J.join(appData, PRODUCT), J.join(localAppData, PRODUCT), slug]
  }
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME || J.join(home, '.config')
    const cache = env.XDG_CACHE_HOME || J.join(home, '.cache')
    return [dataHome, J.join(config, PRODUCT), J.join(cache, PRODUCT), slug]
  }
  return [
    dataHome,
    J.join(home, 'Library', 'Application Support', PRODUCT),
    J.join(home, 'Library', 'Caches', PRODUCT),
    J.join(home, 'Library', 'Caches', 'com.choam.scheherazade'),
    J.join(home, 'Library', 'Caches', 'com.choam.scheherazade.ShipIt'),
    J.join(home, 'Library', 'Preferences', 'com.choam.scheherazade.plist'),
    J.join(home, 'Library', 'Saved Application State', 'com.choam.scheherazade.savedState'),
    J.join(home, 'Library', 'Logs', PRODUCT),
    slug,
  ]
}

function buildUninstallPlan(dataHome, home = os.homedir(), opts = {}) {
  const {
    platform = process.platform,
    env = process.env,
    exePath = null,
    pid = process.pid,
  } = opts
  const dirs = residueDirs(dataHome, home, platform, env)

  if (platform === 'win32') {
    // No bash. The old code's `spawn('/bin/bash')` here was the ENOENT that
    // reached main.cjs's uncaughtException handler and made the app vanish
    // mid-uninstall -- which is why the 501 existed at all. PowerShell is the
    // interpreter that is actually present, at an absolute path (proc.cjs:
    // a packaged app's PATH does not guarantee System32).
    //
    // Wait-Process, then the residue, then the NSIS uninstaller
    // electron-builder wrote beside the exe (oneClick per-user install, so it
    // is `Uninstall Scheherazade.exe` in the install dir). If the uninstaller
    // is not where we expect, the data still goes and the UI says to finish
    // in Settings > Apps -- half a clean uninstall beats a crash.
    const W = nodePath.win32
    const uninstaller = exePath
      ? W.join(W.dirname(exePath), `Uninstall ${PRODUCT}.exe`)
      : W.join(env.LOCALAPPDATA || W.join(home, 'AppData', 'Local'), 'Programs', PRODUCT, `Uninstall ${PRODUCT}.exe`)
    const psq = (p) => `'${String(p).replace(/'/g, "''")}'`
    const script = [
      `Wait-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue`,
      ...dirs.map((d) => `Remove-Item -LiteralPath ${psq(d)} -Recurse -Force -ErrorAction SilentlyContinue`),
      `if (Test-Path -LiteralPath ${psq(uninstaller)}) { Start-Process -FilePath ${psq(uninstaller)} }`,
    ].join('\n')
    // No credential-store line: safeStorage on Windows is DPAPI, which keys
    // to the user account and stores no separate item to delete. The
    // encrypted blobs live in DATA_HOME and go with it.
    return { platform, mode: 'nsis', dirs, script, uninstaller, runner: { cmd: POWERSHELL_EXE, args: ['-NoProfile', '-Command', script] } }
  }

  const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`
  // The script runs DETACHED and waits for this process to DIE first: an
  // Electron app rewrites parts of userData on shutdown, so deleting before
  // exit re-creates residue -- the exact half-clean this feature exists to
  // end. The attach-lane tmux server (if any) is app infrastructure, not a
  // user process: after uninstall it would supervise a deleted launcher, so it
  // goes too.
  const lines = [
    `while /bin/kill -0 ${Number(pid)} 2>/dev/null; do sleep 0.2; done`,
    `pkill -f 'tmux.*-L scheherazade' 2>/dev/null || true`,
    ...dirs.map((d) => `rm -rf ${shq(d)}`),
  ]
  if (platform === 'linux') {
    // The AppImage IS the application: there is no bundle to trash and no
    // package manager entry to remove, so the last act is unlinking the file
    // the user double-clicked. $APPIMAGE is set by the AppImage runtime and
    // is empty for an unpacked/dev run, where there is nothing to unlink.
    lines.push('if [ -n "$APPIMAGE" ] && [ -f "$APPIMAGE" ]; then rm -f "$APPIMAGE"; fi')
    // No credential-store line: safeStorage on Linux goes through the
    // desktop's Secret Service (gnome-keyring / kwallet) and there is no
    // portable, always-present CLI to clear one item. The encrypted blobs go
    // with DATA_HOME, which leaves the key inert rather than leaked.
    return {
      platform,
      mode: 'script',
      dirs,
      script: lines.join('\n'),
      runner: { cmd: '/bin/sh', args: ['-c', lines.join('\n')] },
    }
  }
  lines.push(`security delete-generic-password -s 'Scheherazade Safe Storage' >/dev/null 2>&1 || true`)
  const script = lines.join('\n')
  return { platform, mode: 'bundle-trash', dirs, script, runner: { cmd: '/bin/bash', args: ['-c', script] } }
}

// ── avatar slot (2026-09-28, the owner "프로필 사진") ─────────────────────
// ONE picture per agent, in DATA_HOME beside .agent-config. The extension is
// carried in the filename so the serve path sends the right content-type
// without sniffing again, and so "which slot is occupied" is answerable with
// one existsSync per candidate. The magic bytes are checked BEFORE the write
// (see the POST handler): the extension is the client's claim, the header is
// the file's own, and only the second one is allowed to decide what gets
// stored under a name the server will later hand a browser as image/*.
//
// The fallback is the app icon downscaled to 256px, served from the static
// tree (onboarding/public/img/agent-avatar.png). It exists so that a GET
// ALWAYS has bytes to answer with -- Settings renders the current state
// without probing, and chat's meta row never renders a broken image.
const AVATAR_EXTS = ['png', 'jpg', 'webp']
const AVATAR_MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }
const AVATAR_FALLBACK = nodePath.join(__dirname, '..', 'public', 'img', 'agent-avatar.png')

function createRoutes(staticCtx) {
  const {
    sendJson, readJsonBody, writeAgentConfig, DATA_HOME, getElectron, fs, path,
  } = staticCtx

  // Which slot, if any, is occupied. Returns null when none is (never throws:
  // a stat that races a DELETE is the same answer as no file).
  function readAvatar() {
    for (const ext of AVATAR_EXTS) {
      const full = path.join(DATA_HOME, `avatar.${ext}`)
      try {
        if (fs.statSync(full).isFile()) return { ext, full }
      } catch { /* that slot is empty -- try the next */ }
    }
    return null
  }

  return [
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/settings/rename',
      handler: async (req, res, callCtx) => {
        const { displayName } = await readJsonBody(req)
        if (!displayName || !displayName.trim()) {
          sendJson(res, 400, { error: 'displayName is required' })
          return
        }
        // Identity firewall (2026-08-15, identity-bleed bug): the outgoing name is
        // recorded as a predecessor in .agent-identity in the same request
        // that rewrites DISPLAY_NAME — first-person records written under
        // the old name stay attributable. Best-effort: a provenance-write
        // failure must not block the rename itself (logged, not silent).
        try {
          agentIdentity.recordRename(DATA_HOME, displayName.trim())
        } catch (err) {
          console.error('[scheherazade/onboarding] rename provenance write failed:', err.message)
        }
        const merged = writeAgentConfig({ DISPLAY_NAME: displayName.trim() })
        sendJson(res, 200, { ok: true, config: merged })
        return
      },
    },
    // ── POST /api/settings/avatar: upload the profile picture ──────────────
    // Same body shape as the ONE upload path this server already has
    // (routes/chat.cjs's /api/chat/upload): JSON {filename, dataBase64}
    // through readJsonBody, never multipart -- readJsonBody is the only body
    // reader here, and inventing a second one is how a server ends up with
    // two different size-cap bugs. The cap is smaller (4MB of base64 for a
    // 2MB image) because this file is one small square, not a screenshot.
    // Mutating -> token-gated automatically.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/settings/avatar',
      handler: async (req, res, callCtx) => {
        let parsed
        try {
          parsed = await readJsonBody(req, 4_000_000)
        } catch (err) {
          sendJson(res, 413, { error: 'avatar image too large (2MB max)', reason: 'too_large' })
          return
        }
        const { filename, dataBase64 } = parsed || {}
        const ext = String(filename || '').toLowerCase().match(/\.(png|jpe?g|webp)$/)
        if (!ext) {
          sendJson(res, 400, { error: 'unsupported type -- png, jpg or webp', reason: 'bad_type' })
          return
        }
        const kind = ext[0] === '.png' ? 'png' : ext[0] === '.webp' ? 'webp' : 'jpg'
        if (typeof dataBase64 !== 'string' || !dataBase64) {
          sendJson(res, 400, { error: 'dataBase64 is required', reason: 'no_data' })
          return
        }
        let buf
        try { buf = Buffer.from(dataBase64, 'base64') } catch { buf = null }
        if (!buf || buf.length === 0) {
          sendJson(res, 400, { error: 'could not decode the image data', reason: 'bad_data' })
          return
        }
        if (buf.length > 2_000_000) {
          sendJson(res, 413, { error: 'avatar image too large (2MB max)', reason: 'too_large' })
          return
        }
        // The extension is the CLAIM; the header is the file. An .svg renamed
        // to .png, or a random blob with a .png name, must not land in a slot
        // the server later serves to a browser as image/png -- a wrong
        // content-type is how a browser gets talked into sniffing, and
        // sniffing is how an uploaded file becomes markup.
        const magic = kind === 'png'
          ? (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
          : kind === 'jpg'
            ? (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
            : (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP')
        if (!magic) {
          sendJson(res, 400, { error: 'the file is not the image type its name claims', reason: 'bad_type' })
          return
        }
        try {
          fs.mkdirSync(DATA_HOME, { recursive: true })
          // ONE slot: drop every other-extension sibling FIRST, so a png
          // replacing a jpg cannot leave two files that both answer "is
          // there an avatar". Deleting before writing means a crash in
          // between leaves NO picture (the fallback serves) rather than a
          // stale one wearing the new name's extension.
          for (const other of AVATAR_EXTS) {
            if (other === kind) continue
            try { fs.unlinkSync(path.join(DATA_HOME, `avatar.${other}`)) } catch { /* was not there */ }
          }
          fs.writeFileSync(path.join(DATA_HOME, `avatar.${kind}`), buf, { mode: 0o600 })
          sendJson(res, 200, { ok: true, present: true })
        } catch (err) {
          sendJson(res, 500, { error: `could not save the avatar: ${err.message}`, reason: 'write_failed' })
        }
        return
      },
    },
    // ── GET /api/settings/avatar: the bytes, always ───────────────────────
    // NEVER 404s on a missing avatar: the caller is an <img>/blob consumer
    // that must be able to render SOMETHING, and "no picture yet" is a
    // legitimate state with a defined answer (the app icon at 256px). The
    // static fallback could not be used directly by the page either -- an
    // <img src="/api/..."> 403s on the onboard-token gate, and the static
    // path is fetched with a token by nav.js's shared resolver.
    {
      method: 'GET',
      match: (pathname) => pathname === '/api/settings/avatar',
      handler: async (req, res) => {
        const found = readAvatar()
        const full = found ? found.full : AVATAR_FALLBACK
        const type = found ? AVATAR_MIME[found.ext] : 'image/png'
        let buf
        try { buf = fs.readFileSync(full) } catch {
          // The fallback is a shipped file; if it is missing the build is
          // broken and saying so is more useful than an empty 200.
          sendJson(res, 500, { error: 'the avatar fallback is missing from this build', reason: 'fallback_missing' })
          return
        }
        res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'private, max-age=86400' })
        res.end(buf)
        return
      },
    },
    // ── DELETE /api/settings/avatar: back to the app icon ─────────────────
    // Removing a picture that is not there is the desired end state, not an
    // error -- a user who clicks Remove twice, or on a fresh install, must
    // get the same answer both times.
    {
      method: 'DELETE',
      match: (pathname) => pathname === '/api/settings/avatar',
      handler: async (req, res) => {
        for (const ext of AVATAR_EXTS) {
          try { fs.unlinkSync(path.join(DATA_HOME, `avatar.${ext}`)) } catch { /* already gone */ }
        }
        sendJson(res, 200, { ok: true, present: false })
        return
      },
    },
    // POST uninstall: the whole app, all four residue classes, no Terminal
    // (the owner 07-30 "전체삭제하고 클린테스트하고싶은데" -> productized). Chain:
    // typed-confirm body gate -> stop agent -> spawn the detached cleanup
    // script (fires only after this process dies) -> answer the page ->
    // trash the .app bundle -> exit. Mutating POST, so the per-launch
    // X-Onboard-Token gate has already run.
    {
      method: 'POST',
      match: (pathname) => pathname === '/api/uninstall',
      handler: async (req, res, callCtx) => {
        const { confirm } = await readJsonBody(req)
        // The page sends the literal after its own dialog; a stray curl
        // without it gets nothing. Not a security boundary (the token gate
        // is), a fat-finger boundary.
        if (confirm !== 'DELETE') {
          sendJson(res, 400, { error: 'confirm: "DELETE" is required', reason: 'confirm_required' })
          return
        }
        // This used to be a darwin-only early return answering HTTP 501 with
        // a reason of "unsupported platform". The refusal was RIGHT for the
        // old code --
        // the plan was macOS top to bottom and ran via spawn('/bin/bash')
        // with no 'error' listener, so on Windows that ENOENT became an
        // unhandled 'error' event, main.cjs's uncaughtException handler
        // called fatal(), and the app vanished mid-uninstall: agent already
        // stopped, nothing deleted, no message. What was wrong is that it
        // stayed a refusal (design-0023 P4 deliverable 5): the button
        // rendered on every platform, so two thirds of users got an error
        // toast for a feature the manual promises. There are three plans now,
        // and every spawn below carries the 'error' listener that was the
        // real hazard.
        const { agentControls } = callCtx
        try {
          if (agentControls && typeof agentControls.stopAgent === 'function') await agentControls.stopAgent()
        } catch (err) {
          // The cleanup script kills the tmux lane and the dirs regardless;
          // a stop that failed on a process about to lose its disk is noise.
          console.error('[scheherazade/onboarding] uninstall: stopAgent failed (continuing):', err.message)
        }
        // The Windows plan needs the install dir to find the NSIS uninstaller
        // beside the exe; the mac plan needs it to locate the .app bundle.
        // Best-effort: no Electron (dev-serve-ui) just means the documented
        // default location on win and no bundle trash on mac.
        let exePath = null
        try { exePath = getElectron().app.getPath('exe') } catch { /* dev / no Electron */ }
        const plan = buildUninstallPlan(DATA_HOME, os.homedir(), { exePath })
        const reaper = spawn(plan.runner.cmd, plan.runner.args, { detached: true, stdio: 'ignore' })
        // A detached spawn with no 'error' listener turns ENOENT into an
        // unhandled 'error' event, which main.cjs's uncaughtException handler
        // escalates to app.exit(1). Always attach one.
        reaper.on('error', (err) => console.error('[scheherazade/onboarding] uninstall: reaper spawn failed:', err.message))
        reaper.unref()
        sendJson(res, 200, { ok: true, mode: plan.mode })
        // After the response: hand off to the platform's own removal, then die
        // so the reaper fires.
        //   bundle-trash (mac) -- trash the .app, then exit
        //   nsis (win)         -- the script starts the uninstaller after we die
        //   script (linux)     -- the script unlinks $APPIMAGE after we die
        setTimeout(() => {
          try {
            const { app, shell } = getElectron()
            const finish = () => setTimeout(() => app.exit(0), 300)
            if (plan.mode === 'bundle-trash') {
              const exe = app.getPath('exe') // .../Scheherazade.app/Contents/MacOS/Scheherazade
              const bundle = nodePath.resolve(exe, '..', '..', '..')
              if (bundle.endsWith('.app')) shell.trashItem(bundle).then(finish, finish)
              else finish() // dev electron:dev -- no bundle to trash
            } else {
              finish()
            }
          } catch (err) {
            // dev-serve-ui (no Electron): dirs are scheduled against THIS
            // process's death; say so instead of pretending the app closed.
            console.error('[scheherazade/onboarding] uninstall: no Electron to exit (dev?) -- cleanup fires when this process stops:', err.message)
          }
        }, 300)
        return
      },
    },
  ]
}

module.exports = { createRoutes, buildUninstallPlan }
