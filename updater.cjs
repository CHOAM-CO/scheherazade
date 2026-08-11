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

// "v0.1.5" / "0.1.5" / "0.1.5-rc1" -> [0,1,5]; anything unparseable -> null.
// null NEVER compares as newer -- a garbage tag in the releases repo must not
// be able to trigger an update prompt.
function parseVersion(raw) {
  if (typeof raw !== 'string') return null
  const m = raw.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function isNewerVersion(remote, local) {
  const r = parseVersion(remote)
  const l = parseVersion(local)
  if (!r || !l) return false
  for (let i = 0; i < 3; i++) {
    if (r[i] !== l[i]) return r[i] > l[i]
  }
  return false
}

function pickUpdateMode({ platform, isPackaged }) {
  if (!isPackaged) return 'off'
  if (platform === 'win32') return 'auto'
  return 'notify'
}

async function fetchLatestTag(fetchImpl = fetch) {
  const res = await fetchImpl(LATEST_API, {
    headers: {
      'user-agent': 'scheherazade-updater',
      accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) throw new Error(`GitHub releases API ${res.status}`)
  const body = await res.json()
  const tag = body && body.tag_name
  if (typeof tag !== 'string' || !parseVersion(tag)) {
    throw new Error(`releases API returned unusable tag_name: ${JSON.stringify(tag)}`)
  }
  return tag
}

function initWindowsUpdater({ dialog, log }) {
  // Required lazily so the mac/dev paths never load electron-updater at all.
  const { autoUpdater } = require('electron-updater')
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
  let promptedFor = ''
  autoUpdater.on('update-downloaded', async (info) => {
    log(`updater: ${info.version} downloaded; installs on quit`)
    if (promptedFor === info.version) return // interval re-checks must not re-nag
    promptedFor = info.version
    const { response } = await dialog.showMessageBox({
      type: 'info',
      message: `Scheherazade ${info.version} 준비 완료`,
      detail:
        '업데이트가 다운로드됐습니다. 지금 재시작해서 적용할까요?\n"나중에"를 선택해도 다음 종료 때 자동으로 설치됩니다.',
      buttons: ['지금 재시작', '나중에'],
      defaultId: 0,
      cancelId: 1,
    })
    // quitAndInstall goes through app.quit(), so the before-quit handler in
    // main.cjs still runs and the agent supervisor tree is torn down cleanly
    // (same path as a user-initiated quit).
    if (response === 0) autoUpdater.quitAndInstall()
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
      const tag = await fetchLatestTag()
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
      if (response === 0) shell.openExternal(RELEASES_PAGE)
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
  try {
    if (mode === 'auto') initWindowsUpdater({ dialog, log })
    else if (mode === 'notify') initMacNotifier({ app, dialog, shell, log })
    log(`updater: mode=${mode}`)
  } catch (err) {
    log('updater: init failed (non-fatal):', (err && err.message) || String(err))
  }
  return mode
}

module.exports = {
  initAutoUpdate,
  // exported for tests
  parseVersion,
  isNewerVersion,
  pickUpdateMode,
  fetchLatestTag,
  RELEASES_PAGE,
  LATEST_API,
}
