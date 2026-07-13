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
