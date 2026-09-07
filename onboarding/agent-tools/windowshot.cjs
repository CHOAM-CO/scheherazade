#!/usr/bin/env node
// windowshot -- agent-side "share my screen" helper (같이보기, 2026-08-19 the owner).
//
// Lets the agent see a specific app window the user is looking at:
//   windowshot list                          -> TSV: id, app, title, WxH
//   windowshot shoot --id 4212               -> capture that window to PNG
//   windowshot shoot --app Discord           -> capture by app-name substring
// Prints the absolute PNG path on success (the agent then Reads it, or on a
// vision-less lane asks the caption endpoint -- the SKILL.md owns that flow).
//
// Design constraints, in order:
//   - READ-ONLY: this tool never clicks, types, or moves anything. It is the
//     "같이 보기" half, deliberately not a control surface (decision 2026-08-19:
//     chromux live mode stayed OUT for exactly that reason).
//   - Zero dependencies: runs under the bare `node` the harness already
//     assumes on PATH. macOS uses osascript(JXA) + /usr/sbin/screencapture;
//     Windows uses powershell.exe + user32 PrintWindow via Add-Type; Linux
//     uses wmctrl (or xdotool) to enumerate and ImageMagick `import` (or
//     xwd + magick/convert) to capture -- none of which is a Node package.
//   - Honest failure: on macOS, screencapture's exit code LIES when Screen
//     Recording is denied (docs/probe-0016-attribution.md) -- so success is
//     judged by the output file existing with plausible bytes, and the
//     denied-path error tells the agent to send the user to the app's
//     permission page instead of retrying.
//
// THE LINUX LANE (design-0023 P4, last item). Unlike mac and Windows, the two
// programs this lane needs are NOT part of the OS -- a stock Ubuntu has
// neither wmctrl nor ImageMagick. That turns "missing dependency" into a
// failure mode the other two platforms do not have, and it is the dangerous
// one: an enumerator that is simply absent produces an empty list, and an
// empty list reads to an agent as "the user has no windows open". So every
// Linux exit below NAMES what is missing and the package that provides it,
// and nothing in this file ever returns an empty list as a success. Wayland
// gets the same treatment for a different reason: there is no window
// enumeration or capture API for a CLI to call at all (a Wayland client may
// not see another client's surface, by design), so X11 tools under Wayland
// see only XWayland clients -- a PARTIAL list, which is worse than none if
// nobody says so. We say so.
//
// Exit codes: 1 generic, 2 usage / no match, 4 capture failed, 5 macOS Screen
// Recording denied, 6 a Linux package this needs is NOT INSTALLED (never a
// tool that is installed and failing -- that is 1, so the message can keep
// naming apt/dnf/pacman), 7 no usable display (Wayland
// or DISPLAY unset).
//
// Ships unpacked via build.extraResources (agent child is plain node -- it
// cannot read inside app.asar; same reason chromux ships unpacked). Synced to
// DATA_HOME/bin/agent-tools by harness-render syncAgentTools(); the wrapper
// bakes --data-home in, since the skill text cannot know DATA_HOME at
// template-write time (same rationale as the chromux wrappers).
//
// TESTABILITY. Everything below lives inside createWindowshot({...}), whose
// every host input (platform, env, spawnSync, fs, which, the output streams,
// exit) is a parameter. That is what lets tests/test-windowshot.mjs drive the
// Linux lane -- including the Wayland and missing-package paths -- from a Mac
// without an X server anywhere in sight. The file still behaves exactly as
// before when run as a program; see the require.main block at the bottom.

'use strict'

const fsDefault = require('fs')
const path = require('path')
const osDefault = require('os')
const { spawnSync: spawnSyncDefault } = require('child_process')

const MIN_PLAUSIBLE_PNG = 1024 // a real window capture is KBs; a denied one is absent or ~empty
const MIN_WINDOW_EDGE = 40 // same floor the Windows enumerator applies: below this it is a tooltip, not a window
const X_OK = fsDefault.constants.X_OK

// How many X11 window ids the xdotool fallback will interrogate. xdotool needs
// three spawns per window (name, geometry, pid) where wmctrl needs one spawn
// for the whole desktop, so an unbounded scan on a busy session is seconds of
// fork/exec. Anyone with more than this many mapped, named windows is not
// going to find their window in a TSV either.
const XDOTOOL_SCAN_CAP = 80

// ── window enumeration ───────────────────────────────────────────────────────

const JXA_LIST = `
ObjC.import("CoreGraphics");
ObjC.bindFunction("CFMakeCollectable", ["id", ["void *"]]);
const ns = $.CFMakeCollectable($.CGWindowListCopyWindowInfo(
  $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID));
const out = [];
for (let i = 0; i < ns.count; i++) {
  const w = ObjC.deepUnwrap(ns.objectAtIndex(i));
  if (w.kCGWindowLayer !== 0 || !w.kCGWindowOwnerName) continue;
  const b = w.kCGWindowBounds || {};
  out.push([w.kCGWindowNumber, w.kCGWindowOwnerName, (w.kCGWindowName || ""),
            Math.round(b.Width || 0) + "x" + Math.round(b.Height || 0)]
           .map(v => String(v).replace(/[\\t\\n]/g, " ")).join("\\t"));
}
out.join("\\n")`

// EnumWindows + PrintWindow. PrintWindow(...,2) = PW_RENDERFULLCONTENT --
// needed for DWM-composited apps (Chrome, Discord, Electron). VERIFIED live
// on the Windows box 2026-08-19 (interactive session via schtasks /IT -- a plain
// ssh session sees NO windows, that is Windows session isolation, not a
// bug): list enumerated 6 windows with correct owners, shoot captured the
// running Scheherazade Electron window with readable content.
const PS_LIST = `
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text;
public class WS {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$rows = New-Object System.Collections.Generic.List[string]
[WS]::EnumWindows({ param($h, $l)
  if (-not [WS]::IsWindowVisible($h)) { return $true }
  $len = [WS]::GetWindowTextLength($h); if ($len -eq 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 1); [void][WS]::GetWindowText($h, $sb, $sb.Capacity)
  # $procId, NOT $pid: $PID is PowerShell's read-only automatic variable for
  # the CURRENT process -- using it made every row report app="powershell"
  # (live catch on the Windows box, 2026-08-19).
  $procId = 0; [void][WS]::GetWindowThreadProcessId($h, [ref]$procId)
  $app = try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { "?" }
  $r = New-Object WS+RECT; [void][WS]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -lt 40 -or $ht -lt 40) { return $true }
  $t = ($sb.ToString() -replace "[\\t\\n]", " ")
  $rows.Add("$($h.ToInt64())\`t$app\`t$t\`t\${w}x\${ht}")
  return $true
}, [IntPtr]::Zero) | Out-Null
$rows -join "\`n"`

// ── capture ──────────────────────────────────────────────────────────────────

const PS_SHOOT = (hwnd, out) => `
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Runtime.InteropServices;
public class WC {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$h = [IntPtr]${hwnd}
$r = New-Object WC+RECT; if (-not [WC]::GetWindowRect($h, [ref]$r)) { exit 3 }
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { exit 3 }
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [WC]::PrintWindow($h, $dc, 2)  # 2 = PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc); $g.Dispose()
if (-not $ok) { $bmp.Dispose(); exit 4 }
$bmp.Save("${out.replace(/\\/g, '\\\\')}", [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`

// ── Linux messages ───────────────────────────────────────────────────────────
// Written out here rather than inline so the shape stays comparable to the
// macOS Screen-Recording sentence: say what is wrong, say it is not the user's
// desktop being empty, name the fix concretely, and hand the agent one Korean
// line it can relay. Package names differ per family, so all three are given
// -- an agent that guesses `apt` on Fedora has wasted the user's turn.

const MSG_NO_LISTER = [
  'no window lister on this Linux box. Enumerating X11 windows needs wmctrl or xdotool and NEITHER is installed.',
  'This is a MISSING DEPENDENCY, not an empty desktop -- do NOT tell the user "no windows are open". Ask them to install one:',
  '  Debian/Ubuntu:  sudo apt install wmctrl        (or: sudo apt install xdotool)',
  '  Fedora/RHEL:    sudo dnf install wmctrl        (or: sudo dnf install xdotool)',
  '  Arch:           sudo pacman -S wmctrl          (or: sudo pacman -S xdotool)',
  '사용자에게: 창 목록을 읽을 도구가 없어요 -- wmctrl 이나 xdotool 을 설치해 주세요.',
].join('\n')

const MSG_NO_CAPTURER = [
  'no window capturer on this Linux box. Capture needs ImageMagick (`import`, or `magick import`), or xwd plus magick/convert, and none of those is installed.',
  'This is a MISSING DEPENDENCY, not a permission problem and not a window that resists capture. Ask the user to install ImageMagick:',
  '  Debian/Ubuntu:  sudo apt install imagemagick   (xwd fallback also wants: x11-apps)',
  '  Fedora/RHEL:    sudo dnf install ImageMagick   (xwd fallback also wants: xorg-x11-apps)',
  '  Arch:           sudo pacman -S imagemagick     (xwd fallback also wants: xorg-xwd)',
  '사용자에게: 창을 캡처할 도구가 없어요 -- imagemagick 을 설치해 주세요.',
].join('\n')

const MSG_WAYLAND = [
  'this is a Wayland session, and Wayland has no window-enumeration or window-capture API a command-line tool can call -- a client is not permitted to see or grab another client\'s surface, by design.',
  'The X11 tools (wmctrl / xdotool / import) see XWayland clients only, and there are none here.',
  'Do NOT retry, and do NOT report "no windows are open" -- the desktop is fine, this lane is not available on it.',
  '사용자에게: 이 세션은 Wayland라 같이보기가 안 됩니다. Xorg(X11) 세션으로 로그인하시거나, 화면을 직접 캡처해서 보내 주세요.',
].join('\n')

const MSG_NO_DISPLAY = [
  'no X display (DISPLAY is unset). Window enumeration only works from inside the user\'s own graphical session; an ssh shell, a systemd service or a container has none.',
  'This is session isolation -- the same wall the Windows lane hits over a service session -- not a permission problem and not an empty desktop.',
  'Say that the capture has to run in the user\'s desktop session, or ask the user to send the screenshot themselves.',
].join('\n')

const WAYLAND_PARTIAL_BANNER =
  'windowshot: NOTE -- this is a Wayland session. What follows covers XWayland (legacy X11) windows ONLY; native Wayland windows cannot be enumerated at all. Treat this list as PARTIAL and say so to the user.\n'

// ── arg parsing (pure, so tests can hold it still) ───────────────────────────

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--id' || a === '--app' || a === '--title' || a === '--out' || a === '--data-home') {
      args[a.slice(2).replace('-h', 'H')] = argv[++i] // --data-home -> dataHome
    } else if (a.startsWith('--')) {
      args[a.slice(2)] = true
    } else {
      args._.push(a)
    }
  }
  return args
}

function parseRows(tsv) {
  return tsv.split('\n').filter(Boolean).map((line) => {
    const [id, app, title, size] = line.split('\t')
    return { id, app: app || '', title: title || '', size: size || '' }
  })
}

// Thrown by die() after the injected exit returns. In the real program
// process.exit never returns, so this is dead code there; under a test that
// stubs exit it is what stops the rest of main from running as if nothing had
// gone wrong -- the bug class where a "fatal" error prints and then continues.
class WindowshotExit extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WindowshotExit'
    this.code = code
  }
}

function createWindowshot(deps = {}) {
  const {
    platform = process.platform,
    env = process.env,
    fs = fsDefault,
    spawnSync = spawnSyncDefault,
    tmpdir = () => osDefault.tmpdir(),
    now = () => Date.now(),
    stdout = (s) => process.stdout.write(s),
    stderr = (s) => process.stderr.write(s),
    exit = (code) => process.exit(code),
  } = deps

  const IS_WIN = platform === 'win32'
  const IS_LINUX = platform === 'linux'

  function die(msg, code = 1) {
    stderr(`windowshot: ${msg}\n`)
    exit(code)
    throw new WindowshotExit(msg, code)
  }

  // Where the X11 helpers actually live. Fixed directories first, in the same
  // spirit as onboarding/platform.cjs's binDirsFor -- but unlike that module
  // this one DOES then consult PATH, and the difference is deliberate. The
  // platform table runs inside a Finder/launchd-started Electron app whose
  // PATH is an untrusted inherited value (its security review is explicit
  // about that); windowshot runs as an explicit command in the agent's own
  // shell, where refusing a PATH-installed xdotool would be a false negative
  // that costs the user the feature for no gain.
  const which = deps.which || ((name) => {
    const home = env.HOME || osDefault.homedir()
    const fixed = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/local/sbin', '/usr/sbin', '/snap/bin', path.join(home, '.local', 'bin')]
    const fromPath = String(env.PATH || '').split(path.delimiter).filter(Boolean)
    for (const dir of [...fixed, ...fromPath]) {
      const candidate = path.join(dir, name)
      try {
        fs.accessSync(candidate, X_OK)
        return candidate
      } catch { /* not here, keep looking */ }
    }
    return null
  })

  // XDG_SESSION_TYPE is what logind sets and what every desktop honors;
  // WAYLAND_DISPLAY is the belt to that suspenders (a session started outside
  // logind, or a nested compositor, sets the socket but not the type).
  const isWayland = () =>
    String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY)

  // The APP column, without a spawn. wmctrl -p and xdotool getwindowpid both
  // hand back the owning pid; /proc/<pid>/comm is the kernel's own answer for
  // "what program is that", which is the same thing Get-Process gives the
  // Windows lane and kCGWindowOwnerName gives the mac one.
  function appNameForPid(pid) {
    const id = String(pid || '').trim()
    if (!id || id === '0') return ''
    try {
      const comm = String(fs.readFileSync(`/proc/${id}/comm`, 'utf8')).trim()
      if (comm) return comm
    } catch { /* process gone, or /proc not mounted (a container, a BSD) */ }
    try {
      const argv0 = String(fs.readFileSync(`/proc/${id}/cmdline`, 'utf8')).split('\0')[0]
      if (argv0) return path.basename(argv0)
    } catch { /* nothing further to try */ }
    return ''
  }

  const clean = (s) => String(s == null ? '' : s).replace(/[\t\n\r]/g, ' ').trim()

  // wmctrl is the PRIMARY enumerator, over the xdotool spelling the design
  // note suggested, for three reasons and one of them is decisive:
  //   1. `wmctrl -l -p -G` answers the whole question in ONE spawn -- id,
  //      owning pid, geometry and title per line -- where xdotool needs a
  //      search plus three more spawns per window to reach the same columns.
  //   2. It reads _NET_CLIENT_LIST, i.e. the window manager's own list of
  //      real top-level windows. That is conceptually the same filter the mac
  //      lane gets from kCGWindowLayer === 0 and the Windows lane from
  //      IsWindowVisible + a non-empty title. xdotool's `search --onlyvisible`
  //      is a raw X tree walk and hands back override-redirect surfaces,
  //      menus and input proxies that no user calls "a window".
  //   3. Its output is column-delimited and stable; xdotool's getwindowgeometry
  //      is prose that needs --shell to be parseable at all.
  // Availability is the one place xdotool wins (it is pulled in as a
  // dependency more often), which is exactly why it stays as the fallback
  // rather than being dropped: whichever of the two the user happens to have,
  // the lane works.
  function listViaWmctrl(bin) {
    const r = spawnSync(bin, ['-l', '-p', '-G'], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) return { rows: null, why: clean(r.stderr) || `wmctrl exit ${r.status}` }
    const rows = []
    for (const line of String(r.stdout || '').split('\n')) {
      // id desktop pid x y w h host title...  (title may be empty or contain spaces)
      const m = line.match(/^(\S+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/)
      if (!m) continue
      const [, id, , pid, , , w, h, , title] = m
      if (Number(w) < MIN_WINDOW_EDGE || Number(h) < MIN_WINDOW_EDGE) continue
      rows.push({ id, app: appNameForPid(pid), title: clean(title), size: `${w}x${h}` })
    }
    return { rows, why: '' }
  }

  function listViaXdotool(bin) {
    // `--name .` is "any window with a non-empty name" -- xdotool has no
    // "list everything" verb, and a name regex is the cheapest stand-in for
    // the "a real window has a title" rule the other two platforms apply.
    const search = spawnSync(bin, ['search', '--onlyvisible', '--name', '.'], { encoding: 'utf8', timeout: 15000 })
    // xdotool `search` exits 1 for NO MATCHES -- an empty desktop is a status-1
    // answer, not an error, and it says nothing on stderr when that is what it
    // means. Treating every non-zero status as a failure turned a genuinely
    // empty display into "the tool is broken, do not say no windows", which is
    // the false alarm in exactly the direction this lane exists to prevent. A
    // real failure (no display, bad args) exits non-zero AND explains itself on
    // stderr, so stderr is the discriminator, not the code.
    // Measured on WSLg/Ubuntu 2026-09-07: `search --onlyvisible --name .` with
    // nothing mapped -> status 1, empty stdout, EMPTY stderr; with DISPLAY
    // unset -> status 1 plus "Can't open display" on stderr.
    const searchErr = clean(search.stderr)
    if (search.status !== 0 && (searchErr || search.status !== 1)) {
      return { rows: null, why: searchErr || `xdotool exit ${search.status}` }
    }
    const ids = String(search.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, XDOTOOL_SCAN_CAP)
    const rows = []
    for (const id of ids) {
      // Geometry first: it is the cheap filter, and it fails for the windows
      // that vanished between the search and now (a real race on a live
      // desktop), which skips them without an error the user has to read.
      const geom = spawnSync(bin, ['getwindowgeometry', '--shell', id], { encoding: 'utf8', timeout: 5000 })
      if (geom.status !== 0) continue
      const g = {}
      for (const line of String(geom.stdout || '').split('\n')) {
        const eq = line.indexOf('=')
        if (eq > 0) g[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
      }
      const w = Number(g.WIDTH)
      const h = Number(g.HEIGHT)
      if (!(w >= MIN_WINDOW_EDGE) || !(h >= MIN_WINDOW_EDGE)) continue
      const name = spawnSync(bin, ['getwindowname', id], { encoding: 'utf8', timeout: 5000 })
      // getwindowpid fails on windows that never set _NET_WM_PID; an unknown
      // owner is a blank APP cell, not a dropped row -- the title still lets
      // the user recognize it.
      const pidR = spawnSync(bin, ['getwindowpid', id], { encoding: 'utf8', timeout: 5000 })
      rows.push({
        id,
        app: pidR.status === 0 ? appNameForPid(String(pidR.stdout || '').trim()) : '',
        title: name.status === 0 ? clean(String(name.stdout || '').split('\n')[0]) : '',
        size: `${w}x${h}`,
      })
    }
    return { rows, why: '' }
  }

  // Never returns an empty array: on Linux an empty result is always a
  // diagnosis (Wayland, no display, no tools, or a window manager that does
  // not publish a client list), and returning [] would let `list` and `shoot`
  // both say the desktop is empty when it is not.
  function listLinux() {
    const wayland = isWayland()
    if (!env.DISPLAY) die(wayland ? MSG_WAYLAND : MSG_NO_DISPLAY, 7)

    const wmctrl = which('wmctrl')
    const xdotool = which('xdotool')
    if (!wmctrl && !xdotool) die(MSG_NO_LISTER, 6)

    const failures = []
    let rows = null
    if (wmctrl) {
      const r = listViaWmctrl(wmctrl)
      if (r.rows === null) failures.push(`wmctrl: ${r.why}`)
      else rows = r.rows
    }
    // Two different wmctrl outcomes earn the same second chance: it exited
    // non-zero (the non-EWMH window manager -- "Cannot get client list
    // properties"), or it exited 0 with NOTHING, which is what a window
    // manager that never publishes _NET_CLIENT_LIST looks like. xdotool walks
    // the X tree itself rather than asking the window manager, so it is a
    // different question rather than a retry of the same one -- and on a
    // genuinely empty display it costs exactly one spawn.
    if (xdotool && (rows === null || rows.length === 0)) {
      const r = listViaXdotool(xdotool)
      if (r.rows === null) failures.push(`xdotool: ${r.why}`)
      else if (r.rows.length || rows === null) rows = r.rows
    }

    if (rows === null) {
      // Exit 1 (generic), NOT 6. Code 6 means "a package this needs is not
      // installed" and its message sends the user to apt/dnf/pacman; every
      // lister here IS installed and merely failed, so 6 would tell them to
      // install what they already have. The case that produced this, measured
      // on WSLg 2026-09-07: wmctrl present and healthy (`wmctrl -m` answers
      // "Weston WM"), but Weston never publishes _NET_CLIENT_LIST, so
      // `wmctrl -l` exits 1 with "Cannot get client list properties".
      die(`window listing failed -- ${failures.join(' / ') || 'the lister exited non-zero with no message'}. `
        + 'That is the tool failing, not an empty desktop: report the error, do not report "no windows".', 1)
    }
    if (!rows.length) {
      if (wayland) die(MSG_WAYLAND, 7)
      // One lister answered "nothing" while the other could not answer at all.
      // The both-tools message below is EVIDENCE -- "they disagree about almost
      // everything except an empty display" -- and that evidence does not exist
      // when only one of them actually ran. Saying it anyway would launder a
      // half-answer into a confident "the desktop is empty".
      if (failures.length) {
        die(`one lister found nothing on ${env.DISPLAY} and the other could not answer at all (${failures.join(' / ')}). `
          + 'That is a half-answer, not evidence of an empty desktop: report both facts, and do not assert "no windows are open".', 1)
      }
      // An empty result means two different things depending on what was
      // available to ask, and the answer the agent should give the user
      // differs accordingly. Only the both-tools case is real evidence.
      // THREE cases, because the confidence the agent may express differs in
      // each. The old two-branch version keyed on xdotool alone and said "both
      // listers" whenever xdotool was installed -- including on a box where
      // wmctrl was never installed and therefore never asked. Only the case
      // where two tools that disagree about almost everything BOTH came back
      // empty is real evidence of an empty desktop.
      if (wmctrl && xdotool) {
        die(`both listers found nothing mapped on ${env.DISPLAY}. wmctrl asks the window manager for its client list and xdotool walks the X tree directly; they disagree about almost everything except an empty display, so this most likely IS one -- no application window open. Say that, and name the display you looked at.`, 2)
      }
      if (xdotool) {
        die(`xdotool found nothing mapped on ${env.DISPLAY}, and it is the only lister installed. It walks the X tree directly, so this is decent evidence of an empty display -- but wmctrl is not here to confirm it from the window manager's side. Say the display looked empty and name it; do not state it as certain.`, 2)
      }
      die(`wmctrl returned nothing for ${env.DISPLAY}. That is EITHER an empty display OR a window manager that does not publish _NET_CLIENT_LIST (some tiling and minimal WMs never do, and neither does WSLg's Weston) -- wmctrl cannot tell those apart, so neither can you. Installing xdotool would settle it, since it walks the X tree directly. Do not assert the desktop is empty on this evidence alone.`, 2)
    }
    if (wayland) stderr(WAYLAND_PARTIAL_BANNER)
    return rows
  }

  function enumerate() {
    if (IS_LINUX) return listLinux()
    if (IS_WIN) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { encoding: 'utf8', timeout: 20000 })
      if (r.status !== 0) die(`window listing failed (powershell exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`)
      return parseRows((r.stdout || '').trim())
    }
    const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_LIST], { encoding: 'utf8', timeout: 15000 })
    if (r.status !== 0) die(`window listing failed (osascript exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`)
    return parseRows((r.stdout || '').trim())
  }

  // ImageMagick's `import -window <id>` grabs the window's OWN drawable. Under
  // a compositing window manager (every mainstream desktop since ~2010) that
  // drawable holds the full window even when it is behind something else,
  // which is the Linux equivalent of PW_RENDERFULLCONTENT. Without a
  // compositor, X11 makes no promise about obscured pixels -- hence the
  // "bring it to the front" wording in the failure below rather than a
  // silent, plausible-looking capture of the wrong thing.
  // Returns whatever the tool complained about, so the failure below can quote
  // it. That matters more here than on the other two platforms: the reasons a
  // capture comes back empty on Linux ("unable to read X window image", "no
  // decode delegate", "Cannot open display") are genuinely different problems
  // with genuinely different fixes, and guessing between them in the error
  // text would be the same crime as guessing "no windows are open".
  function shootLinux(win, outPath) {
    const importBin = which('import')
    if (importBin) {
      const r = spawnSync(importBin, ['-silent', '-window', String(win.id), outPath], { encoding: 'utf8', timeout: 30000 })
      return clean(r.stderr)
    }
    // ImageMagick 7 can ship without the legacy `import` symlink; the same
    // code is one subcommand away under `magick`.
    const magick = which('magick')
    if (magick) {
      const r = spawnSync(magick, ['import', '-silent', '-window', String(win.id), outPath], { encoding: 'utf8', timeout: 30000 })
      return clean(r.stderr)
    }
    const xwd = which('xwd')
    const converter = which('convert')
    if (!xwd || !converter) die(MSG_NO_CAPTURER, 6)
    const dumpPath = `${outPath.replace(/\.png$/i, '')}.xwd`
    const grab = spawnSync(xwd, ['-id', String(win.id), '-out', dumpPath], { encoding: 'utf8', timeout: 30000 })
    let why = clean(grab.stderr)
    if (grab.status === 0) {
      const conv = spawnSync(converter, [dumpPath, `png:${outPath}`], { encoding: 'utf8', timeout: 30000 })
      why = clean(conv.stderr) || why
    }
    try { fs.rmSync(dumpPath, { force: true }) } catch { /* the PNG is what matters */ }
    return why
  }

  function shoot(win, outPath) {
    let toolSaid = ''
    if (IS_WIN) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SHOOT(win.id, outPath)], { encoding: 'utf8', timeout: 30000 })
      if (r.status !== 0) die(`capture failed (powershell exit ${r.status}) for hwnd ${win.id} (${win.app}). PrintWindow cannot capture some GPU-composited or minimized windows -- ask the user to un-minimize it, or say honestly that this window resists capture.`, 4)
    } else if (IS_LINUX) {
      toolSaid = shootLinux(win, outPath)
      // Like macOS, the exit code is not the verdict: import writes a
      // zero-byte file and still exits 0 for a window that went away.
    } else {
      spawnSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(win.id), outPath], { encoding: 'utf8', timeout: 30000 })
      // exit code is NOT trusted here -- see header. File check below is the verdict.
    }
    let size = 0
    try { size = fs.statSync(outPath).size } catch { /* absent */ }
    if (size < MIN_PLAUSIBLE_PNG) {
      try { fs.rmSync(outPath, { force: true }) } catch { /* ignore */ }
      if (IS_WIN) die(`capture produced no plausible image for hwnd ${win.id} (${win.app}).`, 4)
      if (IS_LINUX) {
        die(`capture produced no plausible image for window ${win.id} (${win.app}). `
          + (toolSaid ? `The capture tool said: ${toolSaid.slice(0, 300)} -- quote that to the user rather than paraphrasing it. ` : '')
          + (isWayland()
            ? 'This is a Wayland session, so only XWayland windows can be grabbed at all -- if this window is a native Wayland one, no CLI can capture it. Do NOT retry; ask the user to send the screenshot themselves.'
            : 'Without a compositing window manager, X11 cannot hand out the contents of an obscured or minimized window. Ask the user to bring the window to the front and un-minimize it, then try ONCE more; if it fails again, say that this window resists capture.'), 4)
      }
      die('capture produced no plausible image -- on macOS this almost always means Screen Recording permission is DENIED for the app. Do NOT retry. Tell the user: 앱의 권한 페이지에서 Screen Recording을 허용해 주세요 (System Settings > Privacy & Security > Screen Recording), then try again.', 5)
    }
    return outPath
  }

  // wmctrl prints X11 window ids in hex (0x03400007) and xdotool prints the
  // same window in decimal. An agent that read one list and typed the other
  // spelling would get "no window matches", which reads as "that window is
  // gone". Numeric equality when both sides parse as numbers, string equality
  // otherwise -- on mac and Windows both sides are already decimal, so this
  // cannot change what those lanes match.
  function sameId(a, b) {
    const sa = String(a == null ? '' : a).trim()
    const sb = String(b == null ? '' : b).trim()
    if (!sa || !sb) return false
    if (sa === sb) return true
    const na = Number(sa)
    const nb = Number(sb)
    return Number.isFinite(na) && Number.isFinite(nb) && na === nb
  }

  function run(argv) {
    const args = parseArgs(argv)
    const cmd = args._[0]
    if (cmd === 'list') {
      const rows = enumerate()
      if (!rows.length) die(IS_WIN
        ? 'no windows found.'
        : 'no windows found -- if this Mac clearly has windows open, Screen Recording permission may be missing (window titles are hidden without it).', 2)
      stdout('ID\tAPP\tTITLE\tSIZE\n' + rows.map((w) => `${w.id}\t${w.app}\t${w.title}\t${w.size}`).join('\n') + '\n')
      return 0
    }
    if (cmd !== 'shoot') die('usage: windowshot list | windowshot shoot (--id <windowId> | --app <substr> | --title <substr>) [--out <path>]', 2)

    const rows = enumerate()
    let matches = rows
    if (args.id) matches = rows.filter((w) => sameId(w.id, args.id))
    else if (args.app) matches = rows.filter((w) => w.app.toLowerCase().includes(String(args.app).toLowerCase()))
    else if (args.title) matches = rows.filter((w) => w.title.toLowerCase().includes(String(args.title).toLowerCase()))
    else die('shoot needs --id, --app, or --title', 2)

    if (!matches.length) die(`no window matches ${args.id ? '--id ' + args.id : args.app ? '--app ' + args.app : '--title ' + args.title}. Run \`windowshot list\` and pick from what is actually there.`, 2)
    if (matches.length > 1 && !args.id) {
      // Same-app multi-window: pick the largest surface only when unambiguous
      // by a wide margin; otherwise make the agent ask the user.
      stderr('windowshot: multiple matches -- pick one by --id:\n' +
        matches.map((w) => `  ${w.id}\t${w.app}\t${w.title}\t${w.size}`).join('\n') + '\n')
      exit(2)
      throw new WindowshotExit('multiple matches', 2)
    }
    const win = matches[0]

    let outPath = args.out
    if (!outPath) {
      const base = args.dataHome && fs.existsSync(args.dataHome)
        ? path.join(args.dataHome, 'chat_uploads')
        : fs.mkdtempSync(path.join(tmpdir(), 'windowshot-'))
      fs.mkdirSync(base, { recursive: true })
      const slug = (win.app || 'window').replace(/[^\w.-]+/g, '_').slice(0, 32)
      outPath = path.join(base, `windowshot_${now()}_${slug}.png`)
    }
    shoot(win, outPath)
    stdout(outPath + '\n')
    return 0
  }

  // Only tests ever see a return value: in the program, die() has already
  // called the real process.exit before the throw it never reaches.
  function main(argv = process.argv.slice(2)) {
    try {
      return run(argv)
    } catch (err) {
      if (err instanceof WindowshotExit) return err.code
      throw err
    }
  }

  return { main, run, enumerate, shoot, which, isWayland, sameId }
}

module.exports = { createWindowshot, parseArgs, parseRows, WindowshotExit }

// Run as a program only. No process.exit on the success path -- stdout to a
// pipe is asynchronous, and exiting on top of a pending write truncates the
// path the agent is waiting for.
if (require.main === module) createWindowshot().main(process.argv.slice(2))
