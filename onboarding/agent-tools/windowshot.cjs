#!/usr/bin/env node
// windowshot -- agent-side "share my screen" helper (같이보기, 2026-08-19 Mino).
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
//     Windows uses powershell.exe + user32 PrintWindow via Add-Type.
//   - Honest failure: on macOS, screencapture's exit code LIES when Screen
//     Recording is denied (docs/probe-0016-attribution.md) -- so success is
//     judged by the output file existing with plausible bytes, and the
//     denied-path error tells the agent to send the user to the app's
//     permission page instead of retrying.
//
// Ships unpacked via build.extraResources (agent child is plain node -- it
// cannot read inside app.asar; same reason chromux ships unpacked). Synced to
// DATA_HOME/bin/agent-tools by harness-render syncAgentTools(); the wrapper
// bakes --data-home in, since the skill text cannot know DATA_HOME at
// template-write time (same rationale as the chromux wrappers).

'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const IS_WIN = process.platform === 'win32'
const MIN_PLAUSIBLE_PNG = 1024 // a real window capture is KBs; a denied one is absent or ~empty

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

function die(msg, code = 1) {
  process.stderr.write(`windowshot: ${msg}\n`)
  process.exit(code)
}

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
// needed for DWM-composited apps (Chrome, Discord, Electron). UNVERIFIED on
// magi-win as of 2026-08-19 -- the skill says so and the mac lane is primary.
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
  $pid = 0; [void][WS]::GetWindowThreadProcessId($h, [ref]$pid)
  $app = try { (Get-Process -Id $pid -ErrorAction Stop).ProcessName } catch { "?" }
  $r = New-Object WS+RECT; [void][WS]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
  if ($w -lt 40 -or $ht -lt 40) { return $true }
  $t = ($sb.ToString() -replace "[\\t\\n]", " ")
  $rows.Add("$($h.ToInt64())\`t$app\`t$t\`t\${w}x\${ht}")
  return $true
}, [IntPtr]::Zero) | Out-Null
$rows -join "\`n"`

function listWindows() {
  if (IS_WIN) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { encoding: 'utf8', timeout: 20000 })
    if (r.status !== 0) die(`window listing failed (powershell exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`)
    return (r.stdout || '').trim()
  }
  const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_LIST], { encoding: 'utf8', timeout: 15000 })
  if (r.status !== 0) die(`window listing failed (osascript exit ${r.status}): ${(r.stderr || '').slice(0, 300)}`)
  return (r.stdout || '').trim()
}

function parseRows(tsv) {
  return tsv.split('\n').filter(Boolean).map((line) => {
    const [id, app, title, size] = line.split('\t')
    return { id, app: app || '', title: title || '', size: size || '' }
  })
}

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

function shoot(win, outPath) {
  if (IS_WIN) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_SHOOT(win.id, outPath)], { encoding: 'utf8', timeout: 30000 })
    if (r.status !== 0) die(`capture failed (powershell exit ${r.status}) for hwnd ${win.id} (${win.app}). PrintWindow cannot capture some GPU-composited or minimized windows -- ask the user to un-minimize it, or say honestly that this window resists capture.`, 4)
  } else {
    spawnSync('/usr/sbin/screencapture', ['-x', '-o', '-l', String(win.id), outPath], { encoding: 'utf8', timeout: 30000 })
    // exit code is NOT trusted here -- see header. File check below is the verdict.
  }
  let size = 0
  try { size = fs.statSync(outPath).size } catch { /* absent */ }
  if (size < MIN_PLAUSIBLE_PNG) {
    try { fs.rmSync(outPath, { force: true }) } catch { /* ignore */ }
    if (IS_WIN) die(`capture produced no plausible image for hwnd ${win.id} (${win.app}).`, 4)
    die('capture produced no plausible image -- on macOS this almost always means Screen Recording permission is DENIED for the app. Do NOT retry. Tell the user: 앱의 권한 페이지에서 Screen Recording을 허용해 주세요 (System Settings > Privacy & Security > Screen Recording), then try again.', 5)
  }
  return outPath
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args._[0]
  if (cmd === 'list') {
    const rows = parseRows(listWindows())
    if (!rows.length) die(IS_WIN
      ? 'no windows found.'
      : 'no windows found -- if this Mac clearly has windows open, Screen Recording permission may be missing (window titles are hidden without it).', 2)
    process.stdout.write('ID\tAPP\tTITLE\tSIZE\n' + rows.map((w) => `${w.id}\t${w.app}\t${w.title}\t${w.size}`).join('\n') + '\n')
    return
  }
  if (cmd !== 'shoot') die('usage: windowshot list | windowshot shoot (--id <windowId> | --app <substr> | --title <substr>) [--out <path>]', 2)

  const rows = parseRows(listWindows())
  let matches = rows
  if (args.id) matches = rows.filter((w) => String(w.id) === String(args.id))
  else if (args.app) matches = rows.filter((w) => w.app.toLowerCase().includes(String(args.app).toLowerCase()))
  else if (args.title) matches = rows.filter((w) => w.title.toLowerCase().includes(String(args.title).toLowerCase()))
  else die('shoot needs --id, --app, or --title', 2)

  if (!matches.length) die(`no window matches ${args.id ? '--id ' + args.id : args.app ? '--app ' + args.app : '--title ' + args.title}. Run \`windowshot list\` and pick from what is actually there.`, 2)
  if (matches.length > 1 && !args.id) {
    // Same-app multi-window: pick the largest surface only when unambiguous
    // by a wide margin; otherwise make the agent ask the user.
    process.stderr.write('windowshot: multiple matches -- pick one by --id:\n' +
      matches.map((w) => `  ${w.id}\t${w.app}\t${w.title}\t${w.size}`).join('\n') + '\n')
    process.exit(2)
  }
  const win = matches[0]

  let outPath = args.out
  if (!outPath) {
    const base = args.dataHome && fs.existsSync(args.dataHome)
      ? path.join(args.dataHome, 'chat_uploads')
      : fs.mkdtempSync(path.join(require('os').tmpdir(), 'windowshot-'))
    fs.mkdirSync(base, { recursive: true })
    const slug = (win.app || 'window').replace(/[^\w.-]+/g, '_').slice(0, 32)
    outPath = path.join(base, `windowshot_${Date.now()}_${slug}.png`)
  }
  shoot(win, outPath)
  process.stdout.write(outPath + '\n')
}

main()
