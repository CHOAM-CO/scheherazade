'use strict'
// onboarding/bootstrap.cjs — fresh-Mac dependency bootstrap (2026-07-07).
//
// Product constitution (the owner, 2026-07-07): "유저가 절대 CLI창 만지게 하지
// 않는다" -- the app acquires its own dependencies during onboarding.
// Target machine = a brand-new Mac: no brew, no node, no CLIs. Research
// receipt (magi-researcher, 2026-07-07): Homebrew is structurally the
// worst fit (NONINTERACTIVE=1 still sudo-gates), so this module skips it
// entirely:
//
//   codex   -- standalone per-arch binary from GitHub Releases
//              (codex-<arch>-apple-darwin.tar.gz), downloaded by Node's
//              own fetch (which does NOT set com.apple.quarantine --
//              community-consistent but NOT an Apple contract, so we
//              defensively strip the xattr anyway), extracted into
//              DATA_HOME/bin, chmod +x, sha256 recorded (TOFU) and
//              re-checked before every login spawn via verifyManagedBin().
//   ollama  -- official DMG download -> hdiutil attach -> copy Ollama.app
//              into ~/Applications (NO admin needed there) -> symlink the
//              bundled CLI into DATA_HOME/bin -> hdiutil detach. The GUI
//              app is NEVER launched: its first-run /usr/local/bin
//              symlink step is the only admin-password trigger
//              (ollama/ollama#851), so bypassing the GUI = 0 password
//              prompts. The daemon runs headless via `ollama serve`
//              (main.cjs's ensureOllamaDaemon).
//   codex-as-api -- not handled here at all: it ships as a pinned npm
//              dependency inside the app and runs in-process (main.cjs).
//
// Admin-password dialogs under this design: 0.
//
// SECURITY ENVELOPE (same review-gate class as the login shell-out):
//   - Download URLs are FIXED constants below -- no request data ever
//     reaches a URL, a path, or an argv.
//   - Helper binaries (tar/hdiutil/xattr) are absolute /usr/bin paths
//     shipped with macOS itself -- never PATH-resolved.
//   - Everything lands only inside DATA_HOME (same trust domain as the
//     app's own data). sha256 manifest gives tamper-evidence from
//     download time onward (TOFU: we cannot verify the publisher's hash
//     because neither upstream publishes one we can pin robustly; what we
//     CAN guarantee is "the file we spawn is the file we downloaded").

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { pipeline } = require('node:stream/promises')
const { Readable } = require('node:stream')
const { execFile } = require('node:child_process')

// 0.2.9 unification: canonical home -- see onboarding/http-server.cjs DATA_HOME.
// design-0023 P3: through data-home.cjs, so an AGENT_DATA_HOME override puts
// the managed codex/ollama binaries in the SAME home as everything else (this
// literal used to ignore it and install into the default one).
const { resolveDataHome } = require('../data-home.cjs')
const DATA_HOME = resolveDataHome({ allowMem: false })
const MANAGED_BIN_DIR = path.join(DATA_HOME, 'bin')
const MANIFEST_PATH = path.join(MANAGED_BIN_DIR, '.manifest.json')
const STAGING_DIR = path.join(DATA_HOME, 'bootstrap-staging')

// Fixed download sources. arm64-only for now: the DMG itself is arm64
// (electron-builder --mac dmg, arch=arm64), so an x64 asset table would be
// dead code implying a build we don't produce. Revisit with a universal
// build.
const CODEX_TARBALL_URL =
  'https://github.com/openai/codex/releases/latest/download/codex-aarch64-apple-darwin.tar.gz'
const CODEX_TARBALL_INNER_NAME = 'codex-aarch64-apple-darwin' // renamed to `codex` on install (per upstream README)
const OLLAMA_DMG_URL = 'https://ollama.com/download/Ollama.dmg'
const OLLAMA_APP_DEST = path.join(os.homedir(), 'Applications', 'Ollama.app')
const OLLAMA_BUNDLED_CLI = path.join(OLLAMA_APP_DEST, 'Contents', 'Resources', 'ollama')

const DOWNLOAD_TIMEOUT_MS = 300_000 // big files on slow links; generous but bounded
const HELPER_TIMEOUT_MS = 60_000

// FIRST-INSTALL AUTHENTICITY (Codex bootstrap-review finding #1): TOFU
// hashing only detects tamper AFTER install; the first install itself is
// authenticated via Apple's code-signing chain instead of a pinned content
// hash (which would break on every upstream release). Both upstreams ship
// Developer-ID-signed artifacts; we require (a) `codesign --verify
// --strict` validity and (b) the TeamIdentifier to match these pins,
// extracted 2026-07-07 from live signed binaries on the dev machine
// (codesign -dvv: "OpenAI OpCo, LLC" / "Infra Technologies, Inc"):
const PINNED_TEAM_IDS = {
  codex: '2DC432GLL2',
  ollama: '3MU9H2V9Y9',
}

// ── status singleton (same pattern as login-status.cjs) ─────────────────
// states: idle | checking | downloading | installing | installed | failed
// codes (failed only): download_failed | verify_failed | helper_failed |
//                      fs_failed | unsupported_arch | unknown
const BOOTSTRAP_DEPS = ['codex', 'ollama']
const statuses = {}
for (const d of BOOTSTRAP_DEPS) {
  statuses[d] = { state: 'idle', code: null, detail: null, progress: null, since: new Date().toISOString() }
}
function setBootstrapStatus(dep, state, code = null, detail = null, progress = null) {
  statuses[dep] = { state, code, detail, progress, since: new Date().toISOString() }
}
function getBootstrapStatus(dep) {
  return statuses[dep]
}

function log(...args) {
  console.log('[scheherazade/bootstrap]', new Date().toISOString(), ...args)
}

// ── sha256 manifest (TOFU tamper-evidence) ───────────────────────────────
function sha256File(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeManifestEntry(name, entry) {
  const manifest = readManifest()
  manifest[name] = entry
  fs.mkdirSync(MANAGED_BIN_DIR, { recursive: true })
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
}

// Pre-spawn recheck for app-managed binaries (Codex round-3 hardening ask,
// implemented here with the bootstrap step as planned): the file we are
// about to execute must hash to what we recorded at install time. Returns
// true when the binary is NOT app-managed (nothing recorded -- e.g. a brew
// install; that trust decision lives in resolveBin's fixed-location list),
// false ONLY on a real mismatch (tampered/replaced managed file).
function verifyManagedBin(binPath) {
  if (!binPath.startsWith(MANAGED_BIN_DIR + path.sep)) return true
  const name = path.basename(binPath)
  const manifest = readManifest()
  const entry = manifest[name]
  if (!entry || !entry.sha256) {
    // Managed-dir file with no manifest record: fail closed -- nothing we
    // downloaded is ever unrecorded, so this IS an anomaly.
    log(`verifyManagedBin: ${binPath} has no manifest entry -- refusing`)
    return false
  }
  try {
    // Symlinked managed entries (ollama -> Ollama.app CLI) hash the target.
    const ok = sha256File(fs.realpathSync(binPath)) === entry.sha256
    if (!ok) log(`verifyManagedBin: sha256 MISMATCH for ${binPath} -- refusing`)
    return ok
  } catch (err) {
    log(`verifyManagedBin: hashing ${binPath} failed (${err.message}) -- refusing`)
    return false
  }
}

// ── helpers ──────────────────────────────────────────────────────────────
// Resolves { stdout, stderr } -- codesign in particular writes its
// diagnostics to STDERR, so both streams matter.
function runHelper(absBin, argv) {
  return new Promise((resolve, reject) => {
    execFile(absBin, argv, { timeout: HELPER_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        err.stderrTail = String(stderr || '').slice(-400)
        reject(err)
      } else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// Apple-rooted authenticity gate (finding #1/#3): signature must verify
// strictly AND the signing team must match the pin. Runs BEFORE anything
// downloaded is chmod-ed or executed. `--deep` for .app bundles.
async function verifySignedByPinnedTeam(targetPath, dep, { deep = false } = {}) {
  await runHelper('/usr/bin/codesign', ['--verify', '--strict', ...(deep ? ['--deep'] : []), '--', targetPath])
  const { stderr } = await runHelper('/usr/bin/codesign', ['-dvv', '--', targetPath])
  const m = stderr.match(/^TeamIdentifier=(.+)$/m)
  const team = m ? m[1].trim() : null
  if (team !== PINNED_TEAM_IDS[dep]) {
    throw new Error(`codesign team mismatch for ${targetPath}: got ${team}, pinned ${PINNED_TEAM_IDS[dep]}`)
  }
}

async function downloadToFile(url, destPath, dep) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} from ${url}`)
  }
  const total = Number(res.headers.get('content-length')) || null
  let seen = 0
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  const counter = new (require('node:stream').Transform)({
    transform(chunk, _enc, cb) {
      seen += chunk.length
      if (total) setBootstrapStatus(dep, 'downloading', null, null, Math.round((seen / total) * 100))
      cb(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(destPath))
}

// Defensive quarantine strip (idempotent, no admin needed on own files;
// research: Node downloads don't get the xattr today, but that is
// undocumented behavior -- self-heal if it ever changes). -dr recurses for
// .app bundles; harmless on single files.
async function stripQuarantine(targetPath) {
  try {
    await runHelper('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', targetPath])
  } catch (err) {
    // xattr exits nonzero when the attribute is absent -- that IS the
    // normal case. Only log; never fail the install on this.
    log(`stripQuarantine: ${targetPath}: ${err.stderrTail || err.message} (usually just "attribute missing" -- fine)`)
  }
}

// ── codex install ────────────────────────────────────────────────────────
async function installCodex() {
  if (process.arch !== 'arm64') {
    setBootstrapStatus('codex', 'failed', 'unsupported_arch', `이 빌드는 Apple Silicon 전용입니다 (arch=${process.arch}).`)
    return
  }
  const tarPath = path.join(STAGING_DIR, 'codex.tar.gz')
  const extractDir = path.join(STAGING_DIR, 'codex-extract')
  const destPath = path.join(MANAGED_BIN_DIR, 'codex')
  try {
    setBootstrapStatus('codex', 'downloading', null, null, 0)
    await downloadToFile(CODEX_TARBALL_URL, tarPath, 'codex')

    setBootstrapStatus('codex', 'installing')
    // Archive validation BEFORE extraction (Codex bootstrap-review finding
    // #2): a hostile tarball can carry ../, absolute paths, links, or
    // extra members. Require exactly ONE plain regular file with the
    // expected upstream basename, then extract only that member.
    const listing = (await runHelper('/usr/bin/tar', ['-tzf', tarPath])).stdout.split('\n').filter(Boolean)
    if (listing.length !== 1) throw new Error(`tarball must contain exactly 1 entry, got ${listing.length}`)
    const entry = listing[0]
    if (entry.startsWith('/') || entry.split('/').includes('..') || entry.endsWith('/')) {
      throw new Error(`suspicious tarball entry path: ${JSON.stringify(entry)}`)
    }
    if (path.basename(entry) !== CODEX_TARBALL_INNER_NAME) {
      throw new Error(`unexpected tarball member name: ${JSON.stringify(entry)}`)
    }
    const typeChar = (await runHelper('/usr/bin/tar', ['-tvzf', tarPath])).stdout.trimStart()[0]
    if (typeChar !== '-') throw new Error(`tarball member is not a regular file (mode starts '${typeChar}')`)

    fs.rmSync(extractDir, { recursive: true, force: true })
    fs.mkdirSync(extractDir, { recursive: true })
    await runHelper('/usr/bin/tar', ['-xzf', tarPath, '-C', extractDir, '--', entry])
    const extracted = path.join(extractDir, entry)
    if (!fs.lstatSync(extracted).isFile()) throw new Error('extracted member is not a regular file')

    // Publisher authenticity BEFORE the file becomes executable or runs
    // (finding #1): Apple-rooted signature + pinned team.
    await verifySignedByPinnedTeam(extracted, 'codex')

    fs.mkdirSync(MANAGED_BIN_DIR, { recursive: true })
    fs.copyFileSync(extracted, destPath)
    fs.chmodSync(destPath, 0o755)
    await stripQuarantine(destPath)

    // Execution smoke test: Gatekeeper/arch problems surface HERE, inside
    // the step, not later at login time.
    const version = (await runHelper(destPath, ['--version'])).stdout.trim()
    writeManifestEntry('codex', { sha256: sha256File(destPath), version, url: CODEX_TARBALL_URL, installedAt: new Date().toISOString() })
    setBootstrapStatus('codex', 'installed', null, version)
    log(`installCodex: installed ${version} at ${destPath}`)
  } catch (err) {
    const code = String(err.message || '').startsWith('HTTP ') ? 'download_failed' : err.stderrTail !== undefined ? 'helper_failed' : 'unknown'
    setBootstrapStatus('codex', 'failed', code, '설치에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.')
    log(`installCodex FAILED: ${err.message}${err.stderrTail ? ` | ${err.stderrTail}` : ''}`)
  } finally {
    fs.rmSync(tarPath, { force: true })
    fs.rmSync(extractDir, { recursive: true, force: true })
  }
}

// ── ollama install ───────────────────────────────────────────────────────
async function installOllama() {
  const dmgPath = path.join(STAGING_DIR, 'Ollama.dmg')
  let mountPoint = null
  try {
    setBootstrapStatus('ollama', 'downloading', null, null, 0)
    await downloadToFile(OLLAMA_DMG_URL, dmgPath, 'ollama')

    setBootstrapStatus('ollama', 'installing')
    // -nobrowse keeps Finder out of it; -plist gives us the mount point
    // machine-readably.
    const plistOut = (await runHelper('/usr/bin/hdiutil', ['attach', dmgPath, '-nobrowse', '-readonly', '-plist'])).stdout
    const m = plistOut.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/)
    if (!m) throw new Error('hdiutil attach: no mount-point in plist output')
    mountPoint = m[1]

    // Structural checks BEFORE trusting anything in the image (finding
    // #3): the source must be a real directory (no symlink games).
    const srcApp = path.join(mountPoint, 'Ollama.app')
    if (!fs.lstatSync(srcApp).isDirectory()) throw new Error(`Ollama.app in DMG is not a plain directory`)

    // Publisher authenticity of the WHOLE bundle before it lands anywhere
    // executable (finding #1/#3): deep strict verify + pinned team, done
    // against the read-only mounted image.
    await verifySignedByPinnedTeam(srcApp, 'ollama', { deep: true })

    fs.mkdirSync(path.dirname(OLLAMA_APP_DEST), { recursive: true })
    fs.rmSync(OLLAMA_APP_DEST, { recursive: true, force: true })
    // /bin/cp -R preserves the .app bundle structure (symlinks, exec bits)
    // faithfully -- fs.cpSync's symlink handling burned enough people that
    // the system cp is the boring-correct choice for app bundles.
    await runHelper('/bin/cp', ['-R', srcApp, OLLAMA_APP_DEST])
    await stripQuarantine(OLLAMA_APP_DEST)

    const cliStat = fs.lstatSync(OLLAMA_BUNDLED_CLI, { throwIfNoEntry: false })
    if (!cliStat || !cliStat.isFile()) throw new Error(`bundled CLI missing or not a regular file at ${OLLAMA_BUNDLED_CLI}`)
    // Belt-and-suspenders: the CLI carries its own signature -- re-verify
    // the copied binary specifically (the deep bundle check above ran on
    // the mounted image, this one runs on what we actually spawn).
    await verifySignedByPinnedTeam(OLLAMA_BUNDLED_CLI, 'ollama')
    // Symlink into the managed dir so resolveBin() finds it first-priority
    // with zero changes.
    fs.mkdirSync(MANAGED_BIN_DIR, { recursive: true })
    fs.rmSync(path.join(MANAGED_BIN_DIR, 'ollama'), { force: true })
    fs.symlinkSync(OLLAMA_BUNDLED_CLI, path.join(MANAGED_BIN_DIR, 'ollama'))

    const version = (await runHelper(OLLAMA_BUNDLED_CLI, ['--version'])).stdout.trim()
    writeManifestEntry('ollama', { sha256: sha256File(OLLAMA_BUNDLED_CLI), version, url: OLLAMA_DMG_URL, installedAt: new Date().toISOString() })
    setBootstrapStatus('ollama', 'installed', null, version)
    log(`installOllama: installed ${version} at ${OLLAMA_APP_DEST} (GUI never launched -- no admin prompt)`)
  } catch (err) {
    const code = String(err.message || '').startsWith('HTTP ') ? 'download_failed' : err.stderrTail !== undefined ? 'helper_failed' : 'unknown'
    setBootstrapStatus('ollama', 'failed', code, '설치에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.')
    log(`installOllama FAILED: ${err.message}${err.stderrTail ? ` | ${err.stderrTail}` : ''}`)
  } finally {
    if (mountPoint) {
      try {
        await runHelper('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'])
      } catch (err) {
        log(`installOllama: hdiutil detach failed (${err.message}) -- stale mount at ${mountPoint}`)
      }
    }
    fs.rmSync(dmgPath, { force: true })
  }
}

// ── dispatch ─────────────────────────────────────────────────────────────
// Per-dep idempotency sentinel (same pattern as login) PLUS a global
// serialization chain (Codex bootstrap-review finding #4): both installs
// read-modify-write the one manifest file, so concurrent codex+ollama
// installs could lose an entry. The chain makes installs strictly
// sequential; per-dep progress still streams via the status singleton.
const installRunning = { codex: false, ollama: false }
let installChain = Promise.resolve()

async function startBootstrap(dep) {
  if (installRunning[dep]) return // idempotent: poll the status instead
  installRunning[dep] = true
  const run = installChain.then(() => (dep === 'codex' ? installCodex() : installOllama()))
  installChain = run.catch(() => {}) // the chain itself never rejects
  try {
    await run
  } finally {
    installRunning[dep] = false
  }
}

// win-port Phase 3 (the owner LOCKED call 2026-07-13 18:35: Windows v1 =
// detection-only deps). Managed download/install stays mac-only -- this
// whole module is hdiutil/xattr/darwin-arch specific, and the Windows
// analog (MSI/EXE + Authenticode pinning) was priced out of v1. On win the
// app only DETECTS existing installs (resolveBin) and points at the
// official install pages below; the wizard renders link + re-detect
// instead of the download button.
const MANAGED_INSTALL_SUPPORTED = process.platform !== 'win32'
const MANUAL_INSTALL_PAGES = {
  codex: 'https://github.com/openai/codex/releases/latest',
  ollama: 'https://ollama.com/download',
}

module.exports = {
  BOOTSTRAP_DEPS,
  startBootstrap,
  getBootstrapStatus,
  verifyManagedBin,
  MANAGED_BIN_DIR,
  MANAGED_INSTALL_SUPPORTED,
  MANUAL_INSTALL_PAGES,
  // Exported for onboarding/ollama-daemon.cjs (2026-07-07): the reuse-path
  // identity check verifies an already-listening daemon's executable
  // against the same pinned Team ID this installer pins at install time --
  // one identity fact, one place.
  verifySignedByPinnedTeam,
}
