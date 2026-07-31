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
