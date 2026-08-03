# Windows Port — Scoping & Plan (2026-07-13)

> Requested by Mino 07-13 17:57 ("빌드하고 윈도우도 슬슬 준비해주라").
> Inventory below is from a full-repo sweep (file:line receipts in the sweep report);
> the plan layer is Idea's judgment. Test box: magi-win (Win11, RTX 4070 Ti).

## Verdict

The port is one hard problem wearing a shell script, plus a pile of mechanical fixes.
`electron-builder --win` is the easy half, as predicted. The real work is the
**supervisor layer**: `run.sh` exists because Claude Code CLI needs a PTY (piped
stdio drops it into `--print` mode and it exits) and needs its first-run
trust/key prompts auto-answered — that's what `/usr/bin/expect` does. Windows has
no expect; the replacement is a **Node supervisor on node-pty**.

**Recommendation: port by unifying, not by branching.** Build the node-pty
supervisor once and run it on BOTH platforms. One codebase, mac keeps working,
no drift between a bash supervisor and a PowerShell one. `run.sh` stays as the
mac fallback during transition, then retires.

Honest cost of that choice: node-pty is a **native module** — it must be rebuilt
per Electron target per platform. We deliberately have zero native modules today
(`node:sqlite` was chosen for exactly this). This is the one place the port buys
a native-module maintenance burden. No way around it: the PTY requirement is
structural.

## Phases

### Phase 1 — supervisor core (the long pole)
- `supervisor.mjs` (node-pty): replicate run.sh semantics — PIDFILE/STOPFLAG,
  exponential backoff + KST daily reset, session timeout, prompt auto-answer
  table (trust/confirm/dev-channel/text-style → Enter; BYOK "use this key?" →
  bare `1`, the no-trailing-CR quirk is documented in run.sh:321-337 and must
  carry over), identity verification (was `ps -ww`; Windows lane =
  `Get-CimInstance Win32_Process` / tasklist).
- Kill mechanics: negative-pid group signals → `taskkill /PID <pid> /T /F` on
  Windows; keep POSIX group-kill on mac. Applies to main.cjs:890/1017,
  http-server login children, ollama-daemon.

### Phase 2 — spawn/resolve fixes (mechanical, some benefit mac too)
- `resolveClaudeBin()` + `resolveBin()`: `.exe` handling + Windows candidates.
- **extraResources bug (sweep's best catch)**: `claude.exe` → `claude-cli/claude`
  strips the extension; Windows can't exec it. Needs platform-conditional `to:`.
- claude-code win32 platform package: npm only pulls the darwin-arm64 optional
  dep on this Mac — Windows build needs install/CI on win32 to populate it.
- channel.mjs:180 `/tmp/...` literal → `os.tmpdir()` (1 line, portable win;
  deferred during the live click-test round, do first in this lane).

### Phase 3 — dependency story (recommend: detection-only for Windows v1)
- bootstrap.cjs is wholly macOS (DMG/hdiutil/codesign Team-ID pin/xattr).
  Full Windows analog = MSI/EXE download + Authenticode signtool pinning = big.
- **Cheaper v1**: skip managed installs on Windows. Detect existing `codex`/
  `ollama`/Claude Code installs and reuse (same philosophy as the 07-13
  zero-auth "detect + reuse in place" direction Mino ❤️'d). Install buttons
  become "설치 안내 링크 + 재감지" on Windows.
- Hooks `*.sh` (3 files: session-start / felt-check / checkpoint-nudge) +
  scripts `*.sh` (3 files): rewrite as `.mjs` (template already runs the other
  5 hooks via `node`); removes the bash dependency entirely.

### Phase 4 — polish
- window-all-closed / tray behavior decision for Windows (mac dock convention
  doesn't map; likely tray icon).
- tcc-probe: no-op on Windows (TCC doesn't exist — delete from the win path).
- chmod 0o600/0o700 → NTFS ACL hardening or explicit documented no-op.
- UI copy: Terminal→PowerShell wording, "Apple 서명" framing out.
- Unsigned-exe friction: Windows SmartScreen is HARSHER than mac right-click-
  open (blue interstitial, "More info" → "Run anyway"). Release notes must
  document it; Authenticode signing is the real fix, cost/cert = Mino call.

## Order & effort

1 → 2 → 3 → 4. Phase 1 is days (supervisor + both-platform verification on
magi-win), 2 is hours, 3-as-detection-only is hours-to-a-day, 4 is a day.
Managed-install parity (full Phase 3) would add multiple days — recommend
deferring it out of v1.

## Mino calls — LOCKED (2026-07-13 18:35, his home)
1. Windows v1 = detection-only deps: **ㅇㅇ** (no managed ollama/codex install).
2. SmartScreen friction: **감수** (unsigned v1, no Authenticode; release notes
   must document the "More info → Run anyway" flow).
3. Arch: **x64만 지원** — x64 ONLY, arm64 cut entirely (not deferred).

---

## Delta — 2026-08-01 01:3x (Idea, on Mino's "미리 준비해놔" 01:11)

Everything above stands. What changed since 07-13/07-14, verified tonight:

### Gate: Claude Code native Windows — GREEN (fresh receipts 01:1x)
- Native Win10 1809+/Server 2019+, PowerShell/CMD, x64+arm64 (we ship x64
  only per locked call 3). Install: `install.ps1` / winget
  (`Anthropic.ClaudeCode`) / npm (needs Node 22+; binary is native at
  runtime). Headless `-p --output-format stream-json` documented.
  Sources: code.claude.com/docs/en/setup.md, headless.md, cli-reference.md.
- **No sandboxing on native Windows** (WSL2-only feature) — agent Bash/exec
  runs on host. Not a blocker (mac app already runs unsandboxed-equivalent
  for our purposes) but goes in release notes.
- **Shell tool flips on Git-for-Windows presence**: no Git → PowerShell
  tool; Git installed → Git Bash. 딸깍 users won't have Git → our agent
  templates/hooks must survive a PowerShell-tool world OR Phase 3 detection
  screen recommends Git for Windows install. DECISION NEEDED at Phase 3.
- Windows sleep breaks live sessions (community-verified pain) → add
  Electron `powerSaveBlocker` while agent loop is running. New Phase 4 item.
- Pre-v2.1.211 silent stdin crash on Windows is fixed upstream — pin
  bundled CLI ≥ 2.1.211 for the win build.

### Releases that postdate the scoping (both mac-only, neither blocks the port)
- **v0.0.35 vendored tmux + attach topology (design-0016)**: exists to solve
  TCC attribution — a macOS-only problem. Windows has no TCC → the DIRECT
  topology (spawnRealAgentChild seam, which supervisor.mjs already targets)
  is the only topology Windows needs. vendor-tmux.mjs never ports; attach
  lane stays mac-conditional. No new Windows work, one new guard: attach-lane
  code paths must be gated `process.platform === 'darwin'` when Phase 2 lands.
- **v0.0.36 in-app uninstall (buildUninstallPlan)**: plan's residue classes
  are mac paths (~/Library/*, keychain). Windows analog = AppData/%LOCALAPPDATA%,
  Credential Manager, NSIS uninstaller overlap (electron-builder NSIS already
  removes the install dir — our plan only needs the DATA/residue classes).
  Small new Phase 4 item, additive.

### magi-win box state (probed 01:2x via ssh)
- REACHABLE, Windows 11 26100. `node` NOT on ssh PATH, `claude` absent →
  spike prereqs: winget Node LTS + winget Anthropic.ClaudeCode (or install.ps1).
- supervisor-design.md's UNVERIFIED items (Get-CimInstance latency under
  node child_process, ConPTY behavior of bundled CLI, etc.) = the spike
  checklist to run on this box first.

### Status: READY TO EXECUTE
Phase 1 blueprint (supervisor-design.md + supervisor-semantics-inventory.md)
+ Mino's three locked calls (above) + tonight's green gate = nothing left in
"준비" state. Next concrete step when Mino calls it: magi-win spike
(prereqs + UNVERIFIED checklist), then supervisor.mjs implementation.

### Spike executed — 2026-08-01 02:0x (Idea, Mino go 01:23 gated on Skia ACK 01:25)
- magi-win prereqs INSTALLED: Node 24.18.1 LTS + Claude Code **2.1.220**
  (≥2.1.211 stdin-crash fix line; native win32-x64 binary, winget both).
  `claude --version` answers on fresh shell. NOT logged in — auth is
  interactive → Mino's step, flagged.
- Both supervisor-design UNVERIFIED items now VERIFIED BY EXECUTION
  (receipts in supervisor-design.md): CIM CommandLine 268–405ms PASS;
  taskkill /T reaches grandchildren PASS (synthetic tree; re-run vs real
  CLI tree later).
- Box coordination: Skia's REAP experiment co-resident on magi-win —
  E:\iww_build, E:\iww_b002_play, E:\finetune_results, E:\moe_prune are
  his, untouched. Probes ran inside his declared CPU-quiet window.
- Phase 1 (supervisor.mjs implementation) now has zero unverified
  assumptions on the win side.

### Release-lane split — 2026-08-01 (Mino GO 13:58 "릴리즈만 잘 분리해줘 윈/맥", code hygiene delegated)
One codebase, two release lanes. The seam (SUPERVISOR_LANE default bash +
IS_WIN gates) stays the isolation mechanism — no physical code extraction
(delegated call, held).

- **mac lane (unchanged)**: `npm run dist` (alias `dist:mac`) on a mac →
  `release/Scheherazade-{v}-arm64.dmg`. predist/postdist gates untouched;
  postdist mounts the exact-version dmg (126 checks green after this change).
- **win lane (new)**: `npm run dist:win` ON WINDOWS ONLY →
  `release/Scheherazade-Setup-{v}.exe` (NSIS x64). Hard-gated by
  scripts/assert-win32.mjs: asarUnpack ships the local node_modules verbatim,
  so a mac cross-build would package darwin natives (node-pty) into the win
  installer — install-fine, die-at-first-PTY-spawn class.
- **win closure gate**: postdist:win verifies `release/win-unpacked/resources/
  app.asar` (staged by the same electron-builder run; NSIS extraction would
  need 7z). Version illusion killed harder than the mac name-check: the gate
  reads package.json OUT OF the staged asar and demands an exact version
  match. All three fail-closed rails (no exe / no staged asar / stale
  version) verified by execution on mac via platform fake, 2026-08-01.
  NOT yet executed: the happy path on a real win build — first `dist:win`
  run on magi-win is the receipt (waits on box access + token/install plan).
- **branch policy**: master holds everything platform-aware (seam config,
  IS_WIN gates, test gates, release infra — win-port/test-gates a877e20
  merged accordingly). win-port/* is for behavior-changing win work BEFORE
  it is execution-verified on a win box; it merges when its receipts exist.
- **versioning**: one semver, two artifacts per release. Win artifacts ship
  only when the win lane's full-session test has passed (still blocked on
  bot token / install plan — Mino).

---

## 2026-08-04 status pass — what this doc got right, wrong, and what is now answered

Written after the first Windows build shipped, ran on Mino's machine, and the
suite went green there. Everything below is receipts, not plan.

### The scoping's biggest miss

This doc scoped the port and never said the release lane **had never been
executed**. Three independent blockers sat between `npm run dist:win` and an
installer, and all three were found in one sitting on 2026-08-03:

1. `predist` (test-packaging.mjs) mis-flagged 21 files on path separators, so
   electron-builder was never reached.
2. npm 11.16 blocks install scripts by default; mac was on 11.5, so the mac
   lane never saw it. Fixed with `allowScripts` for the four packages that
   need them.
3. `SUPERVISOR_LANE` defaulted to the bash lane on win32 with a hardcoded
   `/bin/bash`, so an unset env var spawned ENOENT and parked the agent at
   'failed' forever -- making the node-pty supervisor built *for this port*
   unreachable without a manually-set variable.

The lesson for the next platform doc: "the lane exists" and "the lane has been
run once" are different claims, and only the second one is worth writing down.

### The Phase 3 shell decision — ANSWERED, by Codex

> "Shell tool flips on Git-for-Windows presence ... DECISION NEEDED at Phase 3."

`openai/codex` makes the terminal an **explicit user setting** (PowerShell /
cmd / Git Bash / WSL), applied to new sessions only -- not auto-detected.

Take that. A shell that silently changes identity because the user installed
Git last Tuesday is an unreproducible bug report, and "it worked yesterday" is
the most expensive sentence a support conversation can contain. Detection may
pick the *default*; it must not own the value.

(Also from the same read: Codex's in-repo `docs/install.md` still says Windows
11 "via WSL2" while its README ships a native PowerShell installer and the
tree has a `windows-sandbox-rs` crate. Treat that doc as stale if anyone
cites it.)

### Items this doc filed, now closed

- **"attach-lane code paths must be gated darwin when Phase 2 lands"** --
  still open. Named again here because it has now survived two passes.
- **Pin bundled CLI >= 2.1.211** -- moot. We no longer bundle the CLI at all
  (its licence has no redistribution grant); the user brings their own, and
  `resolveClaudeBin` locates it. The Windows-specific consequence is new:
  npm's `claude.cmd` shim is deliberately NOT accepted, because ConPTY's
  CreateProcess cannot exec a `.cmd` -- accepting it would produce a "found"
  that dies at spawn. As of 2026-08-04 the message says so instead of
  claiming Claude Code is not installed.
- **`NPM_GLOBAL_BIN_DIRS` win branch** -- now also covers
  `%LOCALAPPDATA%\Microsoft\WinGet\Links`, measured on magi-win, where that is
  the ONLY claude on the box and it resolves today purely because that dir
  happens to be on the inherited PATH.
- **`chmod 0o600` -> "NTFS ACL hardening or explicit documented no-op"** --
  documented no-op, and the reasoning behind the line was corrected: the blobs
  are DPAPI-encrypted by safeStorage before they are written, so the mode was
  defence in depth rather than the protection. icacls remains worth doing as
  hardening. It is not a hole.

### The Windows suite is green, and one of the failures was never ours

52/52 on magi-win, three consecutive runs (2026-08-04). It had never been
fully green before.

The last two failures were one bug, in node, not in us. Minimal reproducer on
node 24.18.1 / libuv 1.52.1: open three local HTTP servers on **distinct**
ports, fetch each once, then call `process.exit()` -- aborts with
`!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:94`, every run. Two
iterations is clean; one server with twenty fetches is clean. The trigger is
three undici pools, not fetch volume. macOS (node 24.7 / libuv 1.51) does not
reproduce at any count.

Full measurements in the commit message of `235e476`. Recorded here because
it is a **platform property, not a test bug**: any shipped code path that
talks to three local origins and then exits hard can hit it, and the app's own
proxy/daemon health checks are exactly that shape.

### Still open (unchanged, listed so the doc is not read as finished)

- Tray + `powerSaveBlocker` (Phase 4). Closing the window still kills the
  agent. Mino's product call, deliberately not taken.
- Stall watchdog is disabled on Windows and says so at every spawn -- into a
  pane the user cannot open. Codex's shape for this is a three-state readiness
  value the UI renders (`ready` / `notConfigured` / `updateRequired`), where
  the third state exists because "do something" and "do something *different
  from last time*" are different user tasks.
- Windows uninstall analog (AppData / Credential Manager / NSIS overlap).
  `/api/uninstall` returns 501 on non-darwin today, which is honest and
  incomplete.
- Unsigned NSIS, SmartScreen friction accepted for v1. Worth knowing before
  anyone buys a certificate: what removes the warning for Codex is **Store /
  winget distribution**, not code signing alone.
