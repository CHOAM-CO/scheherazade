#!/usr/bin/env node
// tests/test-windowshot.mjs -- the 같이보기 helper's Linux lane, driven from
// any host. Run: node tests/test-windowshot.mjs
//
// WHY THIS FILE EXISTS. windowshot.cjs grew a third platform (design-0023 P4,
// last item) and the third one is the only one whose tools are not part of the
// OS. That makes its interesting states MISSING-DEPENDENCY states -- no
// wmctrl, no ImageMagick, a Wayland session, an ssh shell with no DISPLAY --
// and every one of them has the same shape from the outside: a lister that
// returns nothing. If the tool ever answers one of those with an empty list
// and exit 0, the agent tells the user "you have no windows open", which is a
// lie about the user's own screen. So the assertions below are mostly about
// what the tool SAYS when it cannot work, and every failing path is checked
// for an empty stdout as well as for its message.
//
// Nothing here shells out to xdotool, wmctrl or ImageMagick: createWindowshot
// takes platform, env, spawnSync, fs and the tool resolver as parameters, so
// the whole Linux matrix runs on this Mac with no X server in sight. The one
// deliberate exception is the last section, which spawns the real file as a
// program to prove the require.main wiring still works after the refactor.

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require_ = createRequire(path.join(ROOT, 'package.json'))
const TOOL = path.join(ROOT, 'onboarding', 'agent-tools', 'windowshot.cjs')
const { createWindowshot } = require_(TOOL)
const { capabilities, SKILL_REQUIREMENTS } = require_(path.join(ROOT, 'onboarding', 'platform.cjs'))

let pass = 0
let fail = 0
function assert(cond, label) {
  if (cond) { pass++ } else { fail++; console.error(`  FAIL ${label}`) }
}

const ENOENT = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

// One driver for every case: hand it the host it should believe in, get back
// what the program wrote and what it tried to run. `tools` is the set of
// binaries that "exist"; `spawn` answers the calls the lane makes.
function drive({
  platform = 'linux',
  env = { DISPLAY: ':0' },
  tools = [],
  spawn = () => null,
  proc = {},
  statSize = null,
  dataHomeExists = false,
  argv,
}) {
  let out = ''
  let err = ''
  let exitCode = null
  const calls = []
  const removed = []
  const made = []
  const api = createWindowshot({
    platform,
    env,
    which: (name) => (tools.includes(name) ? `/usr/bin/${name}` : null),
    spawnSync: (bin, args, opts) => {
      calls.push({ bin, args: args || [], opts })
      return spawn(bin, args || [], opts) || { status: 0, stdout: '', stderr: '' }
    },
    fs: {
      readFileSync: (p) => {
        if (Object.prototype.hasOwnProperty.call(proc, p)) return proc[p]
        throw ENOENT()
      },
      statSync: () => {
        if (statSize === null) throw ENOENT()
        return { size: statSize }
      },
      rmSync: (p) => { removed.push(p) },
      mkdirSync: (p) => { made.push(p) },
      existsSync: () => dataHomeExists,
      mkdtempSync: () => '/tmp/windowshot-STUB',
      accessSync: () => { throw ENOENT() },
    },
    tmpdir: () => '/tmp',
    now: () => 1700000000000,
    stdout: (s) => { out += s },
    stderr: (s) => { err += s },
    exit: (c) => { if (exitCode === null) exitCode = c },
  })
  const code = api.main(argv)
  return { code, exitCode, out, err, calls, removed, made }
}

// A route table is easier to read than a chain of ifs at every call site.
const routes = (table) => (bin, args) => {
  for (const [matchBin, matchArgs, result] of table) {
    if (!String(bin).endsWith(matchBin)) continue
    if (matchArgs && !matchArgs.every((a, i) => args[i] === a)) continue
    return { status: 0, stdout: '', stderr: '', ...result }
  }
  return null
}

// wmctrl -l -p -G: id, desktop, pid, x, y, w, h, host, title.
// Row 2 is under the 40px floor (a tooltip); row 3 has no title at all.
const WMCTRL_OUT = [
  '0x03400007  0 4242   0    0    1280 800  hostbox Discord — #general',
  '0x03400009  0 4242   10   10   20   20   hostbox tiny tooltip',
  '0x0340000b  1 5150   0    0    1920 1080 hostbox ',
  '',
].join('\n')
const PROC = { '/proc/4242/comm': 'Discord\n', '/proc/5150/comm': 'firefox\n' }
const wmctrlOk = routes([['wmctrl', ['-l', '-p', '-G'], { stdout: WMCTRL_OUT }]])

console.log('1. Linux list via wmctrl: one spawn, the WM\'s own client list, /proc for the app name')
{
  const r = drive({ tools: ['wmctrl'], spawn: wmctrlOk, proc: PROC, argv: ['list'] })
  assert(r.code === 0, 'exit 0')
  const lines = r.out.trim().split('\n')
  assert(lines[0] === 'ID\tAPP\tTITLE\tSIZE', 'the TSV header is the same on every platform')
  assert(lines.length === 3, `only the two real windows are listed (got ${lines.length - 1})`)
  assert(lines[1] === '0x03400007\tDiscord\tDiscord — #general\t1280x800',
    `hex id, /proc comm as APP, spaces preserved in TITLE (got ${JSON.stringify(lines[1])})`)
  assert(lines[2] === '0x0340000b\tfirefox\t\t1920x1080', 'a titleless window still lists, with an empty TITLE cell')
  assert(!r.out.includes('tiny tooltip'), 'a 20x20 surface is filtered out, same 40px floor the Windows lane uses')
  assert(r.calls.length === 1, `wmctrl answers the whole desktop in ONE spawn (got ${r.calls.length})`)
  assert(r.err === '', 'nothing on stderr for a plain successful list')
}

console.log('2. wmctrl present but refusing (non-EWMH WM) falls through to xdotool')
{
  const spawn = routes([
    ['wmctrl', null, { status: 1, stderr: 'Cannot get client list properties.\n' }],
    ['xdotool', ['search'], { stdout: '12345\n67890\n11111\n' }],
    ['xdotool', ['getwindowgeometry', '--shell', '12345'], { stdout: 'WINDOW=12345\nX=0\nY=0\nWIDTH=1024\nHEIGHT=768\nSCREEN=0\n' }],
    ['xdotool', ['getwindowgeometry', '--shell', '67890'], { stdout: 'WINDOW=67890\nX=0\nY=0\nWIDTH=10\nHEIGHT=10\nSCREEN=0\n' }],
    ['xdotool', ['getwindowgeometry', '--shell', '11111'], { stdout: 'WINDOW=11111\nX=0\nY=0\nWIDTH=800\nHEIGHT=600\nSCREEN=0\n' }],
    ['xdotool', ['getwindowname', '12345'], { stdout: 'Firefox — MDN\n' }],
    ['xdotool', ['getwindowname', '11111'], { stdout: 'scratch\n' }],
    ['xdotool', ['getwindowpid', '12345'], { stdout: '5150\n' }],
    ['xdotool', ['getwindowpid', '11111'], { status: 1, stderr: 'window does not have a property _NET_WM_PID\n' }],
  ])
  const r = drive({ tools: ['wmctrl', 'xdotool'], spawn, proc: PROC, argv: ['list'] })
  assert(r.code === 0, 'exit 0 -- the fallback is a real second chance, not a retry of the same tool')
  const lines = r.out.trim().split('\n')
  assert(lines[1] === '12345\tfirefox\tFirefox — MDN\t1024x768', `xdotool row (got ${JSON.stringify(lines[1])})`)
  assert(lines[2] === '11111\t\tscratch\t800x600', 'a window with no _NET_WM_PID keeps its row with a blank APP, it is not dropped')
  assert(lines.length === 3, 'the 10x10 surface is filtered')
  const for67890 = r.calls.filter((c) => c.args.includes('67890'))
  assert(for67890.length === 1 && for67890[0].args[0] === 'getwindowgeometry',
    'geometry runs first and short-circuits: no name/pid spawns for a window that fails the size floor')

  // A wmctrl that exits 0 with an EMPTY client list looks identical to an
  // empty desktop, and on a window manager that never sets _NET_CLIENT_LIST
  // it is not one. xdotool asks a different question, so it gets asked.
  const r2 = drive({
    tools: ['wmctrl', 'xdotool'],
    spawn: routes([
      ['wmctrl', null, { stdout: '' }],
      ['xdotool', ['search'], { stdout: '12345\n' }],
      ['xdotool', ['getwindowgeometry', '--shell', '12345'], { stdout: 'WINDOW=12345\nWIDTH=1024\nHEIGHT=768\n' }],
      ['xdotool', ['getwindowname', '12345'], { stdout: 'Firefox — MDN\n' }],
      ['xdotool', ['getwindowpid', '12345'], { stdout: '5150\n' }],
    ]),
    proc: PROC, argv: ['list'],
  })
  assert(r2.code === 0 && r2.out.includes('Firefox — MDN'),
    'an EMPTY wmctrl client list also falls through to xdotool, not just a failing one')
}

console.log('2b. an empty result says which of the two things it cannot distinguish')
{
  const onlyWmctrl = drive({ tools: ['wmctrl'], spawn: routes([['wmctrl', null, { stdout: '' }]]), argv: ['list'] })
  assert(onlyWmctrl.code === 2, `exit 2, the same code the mac/Windows empty list uses (got ${onlyWmctrl.code})`)
  assert(onlyWmctrl.out === '', 'no stdout')
  assert(/_NET_CLIENT_LIST/.test(onlyWmctrl.err) && /Installing xdotool would settle it/.test(onlyWmctrl.err),
    'with only wmctrl available it says the evidence is ambiguous and names the tool that would resolve it')
  assert(/Do not assert the desktop is empty/.test(onlyWmctrl.err), 'and forbids the confident wrong answer')

  const both = drive({
    tools: ['wmctrl', 'xdotool'],
    spawn: routes([['wmctrl', null, { stdout: '' }], ['xdotool', ['search'], { stdout: '' }]]),
    argv: ['list'],
  })
  assert(both.code === 2 && /most likely IS one/.test(both.err),
    'with BOTH tools agreeing on nothing, it is allowed to say the display really is empty')
  assert(/:0/.test(both.err), 'and it names the display it looked at, since the answer is per-display')
}

console.log('3. neither lister installed: names the packages, and never an empty list')
{
  const r = drive({ tools: [], argv: ['list'] })
  assert(r.code === 6, `exit 6 = missing Linux dependency (got ${r.code})`)
  assert(r.out === '', 'stdout is EMPTY -- an empty TSV body would read as a successful "no windows"')
  for (const needle of ['wmctrl', 'xdotool', 'sudo apt install', 'sudo dnf install', 'sudo pacman -S']) {
    assert(r.err.includes(needle), `the error names ${JSON.stringify(needle)}`)
  }
  assert(/MISSING DEPENDENCY/.test(r.err), 'it says outright that this is a missing dependency')
  assert(r.err.includes('do NOT tell the user "no windows are open"'),
    'it forbids the exact wrong conclusion in so many words -- the same register as the macOS Screen-Recording line')
  assert(r.err.includes('설치해 주세요'), 'it hands the agent one Korean line to relay, like the macOS path does')
}

console.log('4. Wayland is told apart from an empty desktop, three ways')
{
  const noDisplay = drive({ env: { XDG_SESSION_TYPE: 'wayland' }, tools: ['wmctrl', 'import'], argv: ['list'] })
  assert(noDisplay.code === 7, `exit 7 = no usable display (got ${noDisplay.code})`)
  assert(noDisplay.out === '', 'no stdout')
  assert(/Wayland has no window-enumeration/.test(noDisplay.err), 'it explains that the API does not exist')
  assert(/Xorg/.test(noDisplay.err) && /직접 캡처/.test(noDisplay.err), 'it gives the two real options')
  assert(!/apt install/.test(noDisplay.err),
    'it does NOT send the user shopping for packages -- no package fixes Wayland, and suggesting one wastes their turn')
  assert(noDisplay.calls.length === 0, 'and it never even spawns the lister')

  // XWayland present but nothing X11 is mapped: the X tools legitimately
  // return zero rows, which is exactly the sentence this file exists to stop.
  const emptyXWayland = drive({
    env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    tools: ['wmctrl'], spawn: routes([['wmctrl', null, { stdout: '' }]]), argv: ['list'],
  })
  assert(emptyXWayland.code === 7, 'an empty X11 list under Wayland is diagnosed as Wayland, not as "no windows found"')
  assert(!/no windows found/.test(emptyXWayland.err), 'the mac/Windows empty-list sentence never reaches a Wayland box')

  // XWayland with real windows: usable, but the list is partial and says so.
  const partial = drive({
    env: { DISPLAY: ':0', XDG_SESSION_TYPE: 'wayland' },
    tools: ['wmctrl'], spawn: wmctrlOk, proc: PROC, argv: ['list'],
  })
  assert(partial.code === 0, 'XWayland windows still list')
  assert(partial.out.includes('Discord'), '...with their rows intact on stdout')
  assert(/PARTIAL/.test(partial.err) && /XWayland/.test(partial.err),
    'a Wayland banner rides stderr so the TSV on stdout stays machine-readable')
}

console.log('5. no DISPLAY at all is session isolation, not Wayland and not a permission')
{
  const r = drive({ env: {}, tools: ['wmctrl', 'import'], argv: ['list'] })
  assert(r.code === 7, 'exit 7')
  assert(/DISPLAY is unset/.test(r.err), 'it names the actual condition')
  assert(/session isolation/.test(r.err), 'and calls it what the Windows lane calls the same wall')
  assert(!/Wayland/.test(r.err), 'it does not blame Wayland for an ssh shell')
  assert(!/apt install/.test(r.err), 'and does not suggest a package')
}

console.log('6. capture: three implementations, one honest verdict')
{
  const base = { tools: ['wmctrl'], spawn: wmctrlOk, proc: PROC }

  const withImport = drive({ ...base, tools: ['wmctrl', 'import'], statSize: 50000, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'] })
  assert(withImport.code === 0 && withImport.out.trim() === '/tmp/a.png', 'ImageMagick import: prints the path')
  const imp = withImport.calls.find((c) => c.bin.endsWith('import'))
  assert(imp && imp.args.join(' ') === '-silent -window 0x03400007 /tmp/a.png',
    `import is called with the window id from the list (got ${imp ? imp.args.join(' ') : 'no call'})`)

  const withMagick = drive({ ...base, tools: ['wmctrl', 'magick'], statSize: 50000, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'] })
  const mg = withMagick.calls.find((c) => c.bin.endsWith('magick'))
  assert(withMagick.code === 0 && mg && mg.args[0] === 'import',
    'ImageMagick 7 without the legacy import symlink is reached through `magick import`')

  const withXwd = drive({ ...base, tools: ['wmctrl', 'xwd', 'convert'], statSize: 50000, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'] })
  const xwd = withXwd.calls.find((c) => c.bin.endsWith('xwd'))
  const conv = withXwd.calls.find((c) => c.bin.endsWith('convert'))
  assert(withXwd.code === 0, 'xwd + convert is a working third path')
  assert(xwd && xwd.args.join(' ') === '-id 0x03400007 -out /tmp/a.xwd', `xwd dumps beside the target (got ${xwd ? xwd.args.join(' ') : 'no call'})`)
  assert(conv && conv.args.join(' ') === '/tmp/a.xwd png:/tmp/a.png', 'convert writes the PNG explicitly, not by extension guessing')
  assert(withXwd.removed.includes('/tmp/a.xwd'), 'the intermediate dump is cleaned up')

  const noCapturer = drive({ ...base, statSize: 50000, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'] })
  assert(noCapturer.code === 6, `a box that can LIST but not CAPTURE exits 6 (got ${noCapturer.code})`)
  assert(noCapturer.out === '', 'and prints no path')
  for (const needle of ['imagemagick', 'ImageMagick', 'x11-apps']) {
    assert(noCapturer.err.includes(needle), `the error names ${JSON.stringify(needle)}`)
  }
  assert(/not a permission problem/.test(noCapturer.err), 'it rules out the two failure modes it is NOT')

  const tiny = drive({ ...base, tools: ['wmctrl', 'import'], statSize: 12, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'] })
  assert(tiny.code === 4, `an implausible PNG is a capture failure, not a success (got ${tiny.code})`)
  assert(tiny.removed.includes('/tmp/a.png'), 'the junk file is deleted rather than handed to the agent to Read')
  assert(/compositing window manager/.test(tiny.err), 'the X11 explanation, which is the Linux twin of the PrintWindow one')
  assert(/try ONCE more/.test(tiny.err), 'one retry is allowed here (unlike the macOS denial, where retrying is futile)')

  // The tool's own words survive to the agent: "no decode delegate" and
  // "unable to read X window image" are different problems with different
  // fixes, and paraphrasing them away is how a wrong diagnosis gets told
  // confidently.
  const tinyWithReason = drive({
    ...base, tools: ['wmctrl', 'import'], statSize: 12,
    spawn: (bin, args) => (String(bin).endsWith('import')
      ? { status: 1, stdout: '', stderr: 'import: unable to read X window image `0x03400007\'.\n' }
      : wmctrlOk(bin, args)),
    argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'],
  })
  assert(/unable to read X window image/.test(tinyWithReason.err),
    "ImageMagick's own error text reaches the agent verbatim")
  assert(/quote that to the user rather than paraphrasing/.test(tinyWithReason.err),
    '...and the agent is told to pass it on rather than invent a cause')

  const tinyWayland = drive({
    ...base, tools: ['wmctrl', 'import'], statSize: 12,
    env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' },
    argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'],
  })
  assert(tinyWayland.code === 4 && /native Wayland one/.test(tinyWayland.err) && /Do NOT retry/.test(tinyWayland.err),
    'under Wayland the same empty capture gets the Wayland explanation and no retry')

  const noOut = drive({ ...base, tools: ['wmctrl', 'import'], statSize: 50000, argv: ['shoot', '--app', 'discord'] })
  // path.join is the runner's, so the expectation has to be built the same way
  // -- a literal forward-slash path only matches when the runner is not Windows.
  assert(noOut.out.trim() === path.join('/tmp/windowshot-STUB', 'windowshot_1700000000000_Discord.png'),
    `without --out the name is derived from the app (got ${noOut.out.trim()})`)
}

console.log('7. hex and decimal name the same window (wmctrl prints one, xdotool the other)')
{
  const decimal = String(Number('0x03400007'))
  const byDecimal = drive({ tools: ['wmctrl', 'import'], spawn: wmctrlOk, proc: PROC, statSize: 50000, argv: ['shoot', '--id', decimal, '--out', '/tmp/a.png'] })
  assert(byDecimal.code === 0, `--id ${decimal} matches the row listed as 0x03400007`)
  const byHex = drive({ tools: ['wmctrl', 'import'], spawn: wmctrlOk, proc: PROC, statSize: 50000, argv: ['shoot', '--id', '0x03400007', '--out', '/tmp/a.png'] })
  assert(byHex.code === 0, '--id 0x03400007 matches it too')
  const bogus = drive({ tools: ['wmctrl', 'import'], spawn: wmctrlOk, proc: PROC, statSize: 50000, argv: ['shoot', '--id', '999', '--out', '/tmp/a.png'] })
  assert(bogus.code === 2 && /no window matches/.test(bogus.err), 'an id that is neither still misses')

  // Two windows of the same app: the tool refuses to guess and hands the
  // agent the candidate list to put in front of the user. Unchanged behavior,
  // pinned here because the refactor moved the code that does it.
  const ambiguous = drive({
    tools: ['wmctrl', 'import'], proc: { '/proc/4242/comm': 'Discord\n', '/proc/5150/comm': 'Discord\n' },
    spawn: wmctrlOk, statSize: 50000, argv: ['shoot', '--app', 'discord', '--out', '/tmp/a.png'],
  })
  assert(ambiguous.code === 2, `two windows of one app is exit 2, not a coin flip (got ${ambiguous.code})`)
  assert(/multiple matches -- pick one by --id/.test(ambiguous.err) && /0x03400007/.test(ambiguous.err) && /0x0340000b/.test(ambiguous.err),
    'both candidates are printed with their ids')
  assert(ambiguous.out === '', 'and no path is printed, so nothing downstream reads a guessed capture')
  assert(!ambiguous.calls.some((c) => c.bin.endsWith('import')), 'nothing was captured')
}

console.log('8. the mac and Windows lanes are untouched by the refactor')
{
  const macList = drive({
    platform: 'darwin', env: {},
    spawn: routes([['osascript', null, { stdout: '42\tDiscord\tGeneral\t800x600\n' }]]),
    argv: ['list'],
  })
  assert(macList.code === 0 && macList.out === 'ID\tAPP\tTITLE\tSIZE\n42\tDiscord\tGeneral\t800x600\n',
    'mac still lists through osascript/JXA')

  const macDenied = drive({
    platform: 'darwin', env: {},
    spawn: routes([['osascript', null, { stdout: '42\tDiscord\tGeneral\t800x600\n' }]]),
    statSize: null, argv: ['shoot', '--id', '42', '--out', '/tmp/a.png'],
  })
  assert(macDenied.code === 5, `the Screen-Recording denial is still exit 5 (got ${macDenied.code})`)
  assert(/Screen Recording을 허용해 주세요/.test(macDenied.err) && /Do NOT retry/.test(macDenied.err),
    '...with its wording intact')
  const cap = macDenied.calls.find((c) => c.bin.includes('screencapture'))
  assert(cap && cap.args.join(' ') === '-x -o -l 42 /tmp/a.png', 'screencapture is still called the same way')

  const winList = drive({
    platform: 'win32', env: {},
    spawn: routes([['powershell.exe', null, { stdout: '65552\tDiscord\tGeneral\t800x600\n' }]]),
    argv: ['list'],
  })
  assert(winList.code === 0 && winList.out.includes('65552\tDiscord'), 'Windows still lists through PrintWindow/EnumWindows')

  // The list and the capture are the same powershell.exe invocation from the
  // outside; the script text is what tells them apart.
  const winSpawn = (shootStatus) => (bin, args) => (String(args[3] || '').includes('PrintWindow')
    ? { status: shootStatus, stdout: '', stderr: '' }
    : { status: 0, stdout: '65552\tDiscord\tGeneral\t800x600\n', stderr: '' })

  const winRefused = drive({
    platform: 'win32', env: {}, spawn: winSpawn(4), statSize: null,
    argv: ['shoot', '--id', '65552', '--out', 'C:\\tmp\\a.png'],
  })
  assert(winRefused.code === 4 && /resists capture/.test(winRefused.err),
    'PrintWindow exiting non-zero is still "this window resists capture"')

  const winEmpty = drive({
    platform: 'win32', env: {}, spawn: winSpawn(0), statSize: 12,
    argv: ['shoot', '--id', '65552', '--out', 'C:\\tmp\\a.png'],
  })
  assert(winEmpty.code === 4 && /no plausible image for hwnd 65552/.test(winEmpty.err),
    'a Windows capture that exits 0 and writes nothing is still a failure, and does not borrow the Linux or macOS wording')
}

console.log('9. platform.cjs: windowCapture on Linux is a HOST probe, and it gates the skill')
{
  const mk = (platform, over = {}) => capabilities({
    platform,
    arch: 'x64',
    env: {},
    home: '/home/t',
    dataHome: '/home/t/Documents/Scheherazade',
    existsSync: () => false,
    accessSync: () => { throw ENOENT() },
    hasTmux: () => true,
    ...over,
  })
  // "these binaries exist and are executable, nothing else does"
  const has = (...names) => ({
    accessSync: (p) => {
      if (names.some((n) => String(p).endsWith(`/${n}`))) return
      throw ENOENT()
    },
  })

  assert(SKILL_REQUIREMENTS.windowshot === 'windowCapture', 'the windowshot skill is still gated on windowCapture')
  assert(mk('darwin').windowCapture === true && mk('win32').windowCapture === true,
    'mac and Windows stay unconditional -- screencapture and PrintWindow are part of those OSes')
  assert(mk('darwin', has()).windowCapture === true,
    '...and are NOT made conditional on a Linux tool being on disk')
  assert(mk('linux').windowCapture === false,
    'a Linux box with none of the tools reports false, so the skill is not seeded where it could only fail')
  assert(mk('linux', has('wmctrl', 'import')).windowCapture === true, 'wmctrl + import lights it up')
  assert(mk('linux', has('xdotool', 'magick')).windowCapture === true, 'xdotool + magick does too')
  assert(mk('linux', has('xdotool', 'xwd', 'convert')).windowCapture === true, 'so does the xwd + convert fallback pair')
  assert(mk('linux', has('wmctrl')).windowCapture === false, 'a lister with no capturer is not a lane')
  assert(mk('linux', has('import')).windowCapture === false, 'a capturer with no lister is not a lane either')
  assert(mk('linux', has('wmctrl', 'xwd')).windowCapture === false,
    'xwd alone cannot make a PNG -- the probe demands the converter the tool actually needs')
  assert(mk('linux').skillAllowed('windowshot') === false && mk('linux', has('wmctrl', 'import')).skillAllowed('windowshot') === true,
    'seeding follows the probe, so the same box gets the skill the boot after the user installs the package')
}

console.log('10. SKILL.md tells a Linux agent the truth')
{
  const skill = fs.readFileSync(path.join(ROOT, 'onboarding', 'templates', 'skills', 'windowshot', 'SKILL.md'), 'utf8')
  assert(/Wayland/.test(skill), 'Wayland is documented at all')
  assert(/wmctrl/.test(skill) && /ImageMagick/.test(skill), 'the two Linux dependencies are named')
  assert(/apt \/ dnf \/ pacman|apt install/.test(skill), 'the install route is mentioned')
  assert(/DISPLAY is unset/.test(skill), 'the no-display case is documented')
  assert(/PARTIAL/.test(skill), 'the partial-XWayland list is documented, since that one prints rows and still lies by omission')
  assert(/only seeded on a Linux host/.test(skill), 'the skill explains why it exists on this host at all')
  // The doc must not go on claiming the only wall is macOS permission.
  const failureSection = skill.slice(skill.indexOf('## Honest failure modes'))
  assert(/Linux/.test(failureSection), 'the failure-modes section has Linux entries, not just macOS and Windows ones')
}

console.log('11. it still runs as a program (the require.main wiring survived the refactor)')
{
  // No arguments takes the usage path, which is decided before any window
  // enumeration -- so this spawns nothing and touches no screen.
  const r = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', timeout: 20000 })
  assert(r.status === 2, `bare invocation exits 2 with usage (got ${r.status})`)
  assert(/usage: windowshot list \| windowshot shoot/.test(r.stderr || ''), 'and prints the usage line on stderr')
  assert((r.stdout || '') === '', 'and nothing on stdout')
}

console.log('12. empty is not broken, and installed-but-failing is not missing (real-box findings, WSLg 2026-09-07)')
{
  // Everything in this section was measured on a real Linux box after the lane
  // was written, and none of it was caught by sections 1-11: three separate
  // ways the tool told the agent something untrue about a display it could see.

  // (a) `xdotool search` exits 1 for NO MATCHES and says nothing on stderr.
  // That is an answer, not a failure. Reported as a failure it became "the tool
  // is broken, do not report no windows" -- on a desktop that was merely empty.
  const emptySearch = routes([['xdotool', ['search'], { status: 1, stdout: '', stderr: '' }]])
  const a = drive({ tools: ['xdotool'], spawn: emptySearch, argv: ['list'] })
  assert(a.exitCode === 2, `empty xdotool search is an empty result, not a tool failure (exit ${a.exitCode})`)
  assert(!/window listing failed/.test(a.err), 'and is not reported as a listing failure')
  assert(!/both listers/.test(a.err),
    'and does not claim two listers agreed when only one is installed')
  assert(/only lister installed/.test(a.err), 'it says which evidence it actually has')

  // (b) A search that exits 1 WITH stderr is a genuine failure -- stderr is the
  // discriminator, not the exit code.
  const brokenSearch = routes([['xdotool', ['search'], { status: 1, stderr: "Can't open display\n" }]])
  const b = drive({ tools: ['xdotool'], spawn: brokenSearch, argv: ['list'] })
  assert(b.exitCode === 1, `a search that explains itself on stderr IS a failure (exit ${b.exitCode})`)
  assert(/Can't open display/.test(b.err), 'and the tool\'s own words reach the agent')

  // (c) Every installed lister failed. Exit 6 promises "install this package"
  // and would send the user to apt for tools already on the box -- the WSLg
  // case, where wmctrl is healthy but Weston never publishes _NET_CLIENT_LIST.
  const allFail = routes([
    ['wmctrl', ['-l'], { status: 1, stderr: 'Cannot get client list properties.\n' }],
    ['xdotool', ['search'], { status: 1, stderr: "Can't open display\n" }],
  ])
  const c = drive({ tools: ['wmctrl', 'xdotool'], spawn: allFail, argv: ['list'] })
  assert(c.exitCode === 1, `installed-but-failing listers exit 1, never 6 (exit ${c.exitCode})`)
  assert(!/apt install|dnf install|pacman -S/.test(c.err),
    'and never tell the user to install what is already installed')
  assert(/Cannot get client list/.test(c.err), 'the real reason is quoted instead')

  // (d) One lister errored, the other answered "nothing". That is a half
  // answer; the both-listers-agree sentence would launder it into certainty.
  const halfAnswer = routes([
    ['wmctrl', ['-l'], { status: 1, stderr: 'Cannot get client list properties.\n' }],
    ['xdotool', ['search'], { status: 1, stdout: '', stderr: '' }],
  ])
  const d = drive({ tools: ['wmctrl', 'xdotool'], spawn: halfAnswer, argv: ['list'] })
  assert(d.exitCode === 1, `a half answer is not an empty desktop (exit ${d.exitCode})`)
  assert(!/both listers/.test(d.err), 'and must not claim both listers agreed')
  assert(/could not answer at all/.test(d.err), 'it names which half is missing')
  assert(/Cannot get client list/.test(d.err), 'and carries the failing tool\'s reason')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
