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

function createRoutes(staticCtx) {
  const {
    sendJson, readJsonBody, writeAgentConfig, DATA_HOME, getElectron,
  } = staticCtx
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
