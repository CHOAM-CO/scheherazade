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
function buildUninstallPlan(dataHome, home = os.homedir()) {
  const slug = String(dataHome).replaceAll('/', '-')
  const dirs = [
    dataHome,
    nodePath.join(home, 'Library', 'Application Support', 'Scheherazade'),
    nodePath.join(home, 'Library', 'Caches', 'Scheherazade'),
    nodePath.join(home, 'Library', 'Caches', 'com.choam.scheherazade'),
    nodePath.join(home, 'Library', 'Caches', 'com.choam.scheherazade.ShipIt'),
    nodePath.join(home, 'Library', 'Preferences', 'com.choam.scheherazade.plist'),
    nodePath.join(home, 'Library', 'Saved Application State', 'com.choam.scheherazade.savedState'),
    nodePath.join(home, 'Library', 'Logs', 'Scheherazade'),
    nodePath.join(home, '.claude', 'projects', slug),
  ]
  const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`
  // The script runs DETACHED and waits for this process to DIE first: an
  // Electron app rewrites parts of userData on shutdown, so deleting before
  // exit re-creates residue -- the exact half-clean this feature exists to
  // end. The attach-lane tmux server (if any) is app infrastructure, not a
  // user process: after uninstall it would supervise a deleted run.sh, so it
  // goes too.
  const script = [
    `while /bin/kill -0 ${process.pid} 2>/dev/null; do sleep 0.2; done`,
    `pkill -f 'tmux.*-L scheherazade' 2>/dev/null || true`,
    ...dirs.map((d) => `rm -rf ${shq(d)}`),
    `security delete-generic-password -s 'Scheherazade Safe Storage' >/dev/null 2>&1 || true`,
  ].join('\n')
  return { dirs, script }
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
        // darwin only, and fail EARLY. The plan below is macOS top to bottom
        // (~/Library paths, `security delete-generic-password`, pkill) and it
        // runs via spawn('/bin/bash') with no 'error' listener -- on Windows
        // that ENOENT became an unhandled 'error' event, main.cjs's
        // uncaughtException handler called fatal(), and the app vanished
        // mid-uninstall: agent already stopped, nothing deleted, no message.
        // Refusing out loud beats a crash that looks like it worked.
        if (process.platform !== 'darwin') {
          sendJson(res, 501, {
            error: 'in-app uninstall is macOS-only for now; on Windows use Settings > Apps > Scheherazade (the NSIS uninstaller), then delete your data folder',
            reason: 'unsupported_platform',
          })
          return
        }
        const { agentControls } = callCtx
        try {
          if (agentControls && typeof agentControls.stopAgent === 'function') await agentControls.stopAgent()
        } catch (err) {
          // The cleanup script kills the tmux lane and the dirs regardless;
          // a stop that failed on a process about to lose its disk is noise.
          console.error('[scheherazade/onboarding] uninstall: stopAgent failed (continuing):', err.message)
        }
        const plan = buildUninstallPlan(DATA_HOME)
        const reaper = spawn('/bin/bash', ['-c', plan.script], { detached: true, stdio: 'ignore' })
        // A detached spawn with no 'error' listener turns ENOENT into an
        // unhandled 'error' event, which main.cjs's uncaughtException handler
        // escalates to app.exit(1). Always attach one.
        reaper.on('error', (err) => console.error('[scheherazade/onboarding] uninstall: reaper spawn failed:', err.message))
        reaper.unref()
        sendJson(res, 200, { ok: true })
        // After the response: trash the bundle, then die so the reaper fires.
        setTimeout(() => {
          try {
            const { app, shell } = getElectron()
            const exe = app.getPath('exe') // .../Scheherazade.app/Contents/MacOS/Scheherazade
            const bundle = nodePath.resolve(exe, '..', '..', '..')
            const finish = () => setTimeout(() => app.exit(0), 300)
            if (bundle.endsWith('.app')) shell.trashItem(bundle).then(finish, finish)
            else finish() // dev electron:dev -- no bundle to trash
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
