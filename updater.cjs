// updater.cjs -- self-update wiring (0.1.5).
//
// Why this file exists: until 0.1.4 every fix reached users by hand -- build
// the exe/dmg, send the file, ask them to reinstall. That does not survive
// more than a couple of users. This module closes the loop against the public
// releases repo (Mino-is-me/scheherazade-releases) so "shipped" means
// "arrives on its own".
//
// Three modes, picked by pickUpdateMode():
//
//   'auto'   -- Windows, packaged. Full electron-updater flow over the NSIS
//               installer: check -> download in background -> install on quit
//               (plus an optional restart-now prompt). electron-updater reads
//               its feed location from the app-update.yml electron-builder
//               embeds at package time (from package.json build.publish), and
//               compares against latest.yml in the newest GitHub release --
//               WHICH MEANS latest.yml AND the .blockmap MUST be uploaded to
//               the release alongside the exe, or every check 404s. The ship
//               runbook (docs/RELEASE.md) carries that step.
//
//   'notify' -- macOS, packaged. NO auto-install, deliberately: the mac build
//               is ad-hoc signed (build.mac.identity "-") and Squirrel.Mac
//               refuses to install updates that are not validly code-signed;
//               the dmg target is also not an updater-servable artifact (that
//               needs zip). Rather than ship a flow that always fails at
//               install time, we do an honest version check against the
//               GitHub releases API and offer the download page. If a real
//               Apple Developer identity ever lands, revisit.
//
//   'off'    -- unpackaged (electron:dev). Never check, never prompt.
//
// Failure posture: every network/updater error is log-only, never a dialog
// and never fatal(). Being offline is a normal state for this app; an update
// check is the least important thing it does.
'use strict'

// 0.2.9 unification (2026-08-21, the owner "진짜 통합"): back on the live public
// feed. The dsh track is the main line -- appId/productName/data home now
// equal the 0.1.x line's, so a 0.2.9+ release on this feed IS a plain
// upgrade for every installed copy, and the 0.1.x-era cross-coupling worry
// (two products sharing one feed) no longer exists. The 0.2.1-0.2.8 test
// builds pointed at the private CHOAM-CO/scheherazade repo (404 = updates
// off); those installs need one manual reinstall to land on this feed.
const UPDATE_OWNER = 'Mino-is-me'
const UPDATE_REPO = 'scheherazade-releases'
const RELEASES_PAGE = `https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`
const LATEST_API = `https://api.github.com/repos/${UPDATE_OWNER}/${UPDATE_REPO}/releases/latest`

// First check waits out the boot storm (onboarding server + agent spawn own
// the first seconds); after that a slow cadence -- users leave this running
// for days, and unauthenticated GitHub API allowance is 60/hr/IP shared with
// anything else on the machine.
const FIRST_CHECK_DELAY_MS = 15 * 1000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

const { parseSemver, isNewerVersion, isPrerelease, fetchLatestRelease } = require('./onboarding/update-version.cjs')
// Legacy exported triple parser; comparison always uses full SemVer.
function parseVersion(raw) { return parseSemver(raw)?.core.map(Number) || null }

function pickUpdateMode({ platform, isPackaged }) {
  if (!isPackaged) return 'off'
  if (platform === 'win32') return 'auto'
  return 'notify'
}

async function fetchLatestTag(fetchImpl = fetch, current = '') {
  return (await fetchLatestRelease({ repo: `${UPDATE_OWNER}/${UPDATE_REPO}`, current, fetchImpl })).tag_name
}

function initWindowsUpdater({ app, dialog, log, updater: injectedUpdater, profileOptions, updaterDeps = {} }) {
  // Required lazily so the mac/dev paths never load electron-updater at all.
  const { autoUpdater } = injectedUpdater ? { autoUpdater: injectedUpdater } : require('electron-updater')
  autoUpdater.allowPrerelease = isPrerelease(app.getVersion())
  autoUpdater.allowDowngrade = false
  autoUpdater.autoDownload = true
  // The safety net: even if the user dismisses the restart prompt (or it
  // never fires), the downloaded update installs on next quit.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('error', (err) => {
    log('updater: error (non-fatal):', (err && err.message) || String(err))
  })
  autoUpdater.on('update-available', (info) => {
    log(`updater: ${info.version} available, downloading in background`)
  })
  // design-0029: default-only installs retain the original no-lock updater path.
  const fs = updaterDeps.fs || require('node:fs')
  const path = require('node:path')
  const profiles = require('./profile.cjs')
  const proc = require('./proc.cjs')
  const readCommandLine = updaterDeps.readCommandLine || proc.readCommandLine
  const kill = updaterDeps.kill || process.kill
  const options = profileOptions || { appData: app.getPath('appData') }
  const ownPid = updaterDeps.pid || process.pid
  const current = require('./data-home.cjs').resolveDataHome({ allowMem: false })
  const siblings = () => profiles.listProfiles(options).filter(p => p.dataHome !== current && p.running)
  const multipleProfiles = () => profiles.listProfiles(options).some(p => !p.isDefault)
  const claimPath = version => path.join(options.appData, `.scheherazade-update-${String(version).replace(/[^a-zA-Z0-9.-]/g, '_')}.pid`)
  const held = new Set()
  const ownerLive = record => {
    try {
      if (!Number.isInteger(record.pid) || record.pid <= 0 || !record.command) return false
      kill(record.pid, 0)
      return readCommandLine(record.pid).trim() === record.command
    } catch { return false }
  }
  const readOwner = file => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { if (e.code === 'ENOENT' || e instanceof SyntaxError) return null; throw e }
  }
  function release(file) {
    try {
      if (readOwner(file)?.pid === ownPid) fs.unlinkSync(file)
    } catch (e) { log('updater: claim cleanup failed:', e.message) }
    held.delete(file)
  }
  function claim(version) {
    if (!multipleProfiles()) return true
    const file = claimPath(version)
    try {
      // A receipt suppresses late cached-download events after the claim is released.
      const shown = readOwner(`${file}.shown`)
      if (shown && ownerLive(shown)) return false
      const owner = readOwner(file)
      if (owner && ownerLive(owner)) return owner.pid === ownPid
      if (owner || fs.existsSync(file)) fs.unlinkSync(file)
      const command = readCommandLine(ownPid).trim()
      if (!command) return false
      fs.mkdirSync(options.appData, { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ pid: ownPid, command }), { flag: 'wx' })
      held.add(file)
      return true
    } catch (e) {
      // EEXIST means another process won; never unlink its claim.
      log('updater: sibling downloader owns prompt:', e.message)
      return false
    }
  }
  function updateQuitSafety() {
    try { autoUpdater.autoInstallOnAppQuit = siblings().length === 0 }
    catch (e) { autoUpdater.autoInstallOnAppQuit = false; log('updater: sibling check failed:', e.message) }
  }
  app.on?.('before-quit', () => {
    updateQuitSafety()
    for (const file of [...held]) release(file)
  })
  let downloadVersion = ''
  let downloadOwner = false
  autoUpdater.on('update-available', info => {
    downloadVersion = info.version
    downloadOwner = claim(info.version)
    updateQuitSafety()
  })
  let promptedFor = ''
  autoUpdater.on('update-downloaded', async (info) => {
    const file = claimPath(info.version)
    try {
      log(`updater: ${info.version} downloaded; installs on quit`)
      updateQuitSafety()
      if (promptedFor === info.version) return
      if (!(downloadVersion === info.version && downloadOwner) && !claim(info.version)) {
        log('updater: sibling downloader owns prompt')
        return
      }
      promptedFor = info.version
      if (held.has(file)) {
        const record = readOwner(file)
        fs.writeFileSync(`${file}.shown`, JSON.stringify(record))
        held.add(`${file}.shown`)
        release(file) // design-0029: receipt prevents duplicates after prompt ownership is released.
      }
      const live = siblings()
      if (live.length) {
        await dialog.showMessageBox({ type: 'info', message: `Scheherazade ${info.version} 준비 완료`,
          detail: `다른 세라 (${live.map(p => p.name || 'default').join(', ')})도 닫혀야 설치돼`,
          buttons: ['나중에'], defaultId: 0, cancelId: 0 })
        return
      }
      const { response } = await dialog.showMessageBox({
        type: 'info', message: `Scheherazade ${info.version} 준비 완료`,
        detail: '업데이트가 다운로드됐습니다. 지금 재시작해서 적용할까요?\n"나중에"를 선택해도 다음 종료 때 자동으로 설치됩니다.',
        buttons: ['지금 재시작', '나중에'], defaultId: 0, cancelId: 1,
      })
      // Recheck after a modal prompt: a sibling may have started meanwhile.
      updateQuitSafety()
      if (response === 0 && autoUpdater.autoInstallOnAppQuit) autoUpdater.quitAndInstall()
    } catch (err) { log('updater: restart prompt failed (non-fatal):', err.message) }
    finally { if (held.has(file)) release(file) }
  })
  const check = () =>
    autoUpdater.checkForUpdates().catch((err) => {
      log('updater: check failed (non-fatal):', (err && err.message) || String(err))
    })
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.()
  setInterval(check, CHECK_INTERVAL_MS).unref?.()
}

function initMacNotifier({ app, dialog, shell, log }) {
  let promptedFor = ''
  const check = async () => {
    try {
      const tag = await fetchLatestTag(fetch, app.getVersion())
      if (!isNewerVersion(tag, app.getVersion())) return
      if (promptedFor === tag) return // one prompt per version per run
      promptedFor = tag
      log(`updater: ${tag} available (running ${app.getVersion()}); offering download page`)
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: `Scheherazade ${tag.replace(/^v/i, '')} 업데이트가 있습니다`,
        detail: `현재 버전은 ${app.getVersion()}입니다. 다운로드 페이지에서 새 버전을 받아 설치해 주세요.`,
        buttons: ['다운로드 페이지 열기', '나중에'],
        defaultId: 0,
        cancelId: 1,
      })
      if (response === 0) shell.openExternal(`https://github.com/${UPDATE_OWNER}/${UPDATE_REPO}/releases/tag/${encodeURIComponent(tag)}`)
    } catch (err) {
      log('updater: check failed (non-fatal):', (err && err.message) || String(err))
    }
  }
  // unref: these timers must never be the thing keeping the process alive
  // (matters for tests requiring this module; harmless in Electron main).
  setTimeout(check, FIRST_CHECK_DELAY_MS).unref?.()
  setInterval(check, CHECK_INTERVAL_MS).unref?.()
}

// Entry point, called once from main.cjs after boot. Must never throw:
// updating is strictly less important than everything else the app does.
function initAutoUpdate({ app, dialog, shell, log }) {
  const mode = pickUpdateMode({ platform: process.platform, isPackaged: app.isPackaged })
  // Logged BEFORE the branch: the mode is already decided, and a throw inside
  // init (electron-updater missing on a win32 box) must not eat the one line
  // that says which lane we picked.
  log(`updater: mode=${mode}`)
  try {
    if (mode === 'auto') initWindowsUpdater({ app, dialog, log })
    else if (mode === 'notify') initMacNotifier({ app, dialog, shell, log })
  } catch (err) {
    log('updater: init failed (non-fatal):', (err && err.message) || String(err))
  }
  return mode
}

module.exports = { initWindowsUpdater,
  initAutoUpdate,
  // exported for tests
  parseVersion,
  isNewerVersion,
  pickUpdateMode,
  fetchLatestTag,
  RELEASES_PAGE,
  LATEST_API,
}
