# Design 0023 — Cross-platform simultaneous support (0.3.0)

Date: 2026-09-07. Author: idea. Directive: Mino 17:10 (full refactor on MAX), 17:13 (git first; win/mac/linux simultaneous from this version), 17:57 (main = latest, 0.1.18 archived; Linux = WSL build), 18:12 (workers = opus).
Inputs: five complete reads of the tree at 5eb8afe — MAGI_Memory/docs/scheherazade-xplat-read-20260907/read-{A,B,C,D,E}.md (main/packaging, runtime lanes, onboarding, channels/memory/scripts/tests, docs/history).

## Verdict

Today's "three platforms" is one mac code path with a Windows fork; Linux inherits the mac else-branch by accident. Evidence:
1. `release/Scheherazade-0.2.20-x86_64.AppImage` (the published asset, same size) is ELF aarch64 with darwin natives (koffi/sharp/ripgrep) — built on the Mac, nothing guarded it (only `dist:win` has an assert).
2. Two supervisors: bash `run.sh` loop on mac+linux, node `supervisor.mjs` on win; three watchdog implementations (gtimeout / manual sleep+pkill / powershell CIM). `SUPERVISOR_LANE=node` already runs the Windows path on POSIX and is covered by test-supervisor.
3. 24 binary `platform === 'win32'` tests in onboarding: on Linux the wizard offers "Install automatically" then fetches an apple-darwin tarball and calls hdiutil; uninstall is 501; blur is inert; `resolveBin` never looks in /usr/bin or ~/.local/bin.
4. No `npm test`, no runner, no CI; RELEASE.md's for-loop is the de-facto runner and never exits non-zero. Zero evidence the suite ever ran on Linux.
5. Every installer ships 95 dev/test scripts, docs/**, main-v2.cjs (dead testbed contradicting the 0.2.9 fold-in), with fleet names inside.

Definition of "simultaneous": one commit → three artifacts, each built on its own host by one driver; one runtime code path (node supervisor on all three); platform capabilities as an explicit 3-state table (supported / unsupported with honest UI / not applicable) instead of mac-else; one test gate green on all three boxes.

## Locks preserved (not up for refactor)

- Linux builds in WSL on magi-win (Mino 17:57); no GitHub CI for builds. Mac stays arm64-only; Windows x64, unsigned, detection-only (docs/windows-port-scoping.md).
- dsh engine seams: rc-7 + 19 direct plugin deps, `--expose-internals`, `web --port 0`, DSH_HOME seeds, Origin rewrite, `!!js` secret seam, tool-ask-user off, EMPTY_RESPONSE excluded from retries, turn-error recycle, subagent model pin (decisions.log 70/71/72/74/79/93/115/239; design-0021).
- Identity + DATA_HOME `~/Documents/Scheherazade` + public updater feed (decisions.log 114/115); tool names frozen; `<channel>` tag bytes + ingest token (design-0020); PIDFILE/STOPFLAG/FAILFILE contract; templates rendered, never copied; design-0016 invariant (the app never creates a tmux server).
- Product: no popups, receipts, no marketplace. Release rule (decisions.log 73): idea E2E on both magi-mac and magi-win before publish — extended with a Linux xvfb boot smoke in WSL.

## Phases

Branch `refactor/xplat-0.3` off main 5eb8afe; one sub-branch + PR per phase; `npm test` green on mac before hand-back, on magi-win + WSL at phase boundaries; workers = opus subagents with the read-* files as their map; review = idea.

**P0 — Hotfix 0.2.20 Linux (today, no code).** Native x64 AppImage from WSL, header-verified (`file` = x86-64; linux natives present), replaces the v0.2.20 release asset.

**P1 — Test gate first (S).** `npm test` → `scripts/run-tests.mjs`: enumerate `test-*.{mjs,cjs}` + `memory/smoke.mjs`, spawn with `process.execPath`, per-file timeout, PASS/FAIL/SKIP accounting, non-zero exit on FAIL, `--live` for the calendar / tmux / packaging-artifact lanes, `--filter`. Hermetic fixes: `'node'` → `process.execPath`; tmp `AGENT_DATA_HOME` before importing channel-local; the `/Users/narr/Desktop/MAGI` pin; pointer-scan symlink section → SKIP without privilege; capability probes instead of whole-file win32 skips where cheap. Explicit `linux` rows in the updater / window-glass / setup-token-copy / uninstall-plan tables, pinning CURRENT behavior (no behavior change in P1).

**P2 — Build & release pipeline (M).**
- `dist:linux` + `scripts/assert-platform.mjs` (generalizes assert-win32: linux/x64 only on linux x64, mac only on darwin arm64, win only on win32); `linux.artifactName` uses `${arch}`; test-packaging gains a linux lane and a NATIVES lane (each bundle contains its own platform's koffi/sharp/ripgrep/landlock and none of another's — the 0.2.20 defect class).
- `npm ci` green on all three: regenerate package-lock (5 entries missing on newer npm), `packageManager` pin; magi-win node 22 → 24 (engines floor) — box change, done by idea.
- Retire top-level node-pty + fix-pty-helper + probe-pty (only setup-token-session's pty fallback uses it; in-app OAuth is primary since 0.2.18; dsh nests its own node-pty with all prebuilds). The worker verifies the token-paste path stays before deleting.
- Stop shipping the dev payload: tests → `tests/`, tools → `tools/`, the three runtime scripts (journal-compress, madoromi-solo, persona-reflux) stay where CLAUDE.md points; trim `build.files` / `asarUnpack` (drop docs/**, memory/smoke, main-v2.cjs); scrub fleet names from shipped files.
- `scripts/release-all.mjs` driver: from a tag on main → mac dmg local; `git archive` → magi-win `npm ci && npm run dist:win`; → WSL `npm ci && npm run dist:linux`; pull assets to release/, verify header/arch/natives/yml/size per asset; write latest.yml + latest-mac.yml + latest-linux.yml; `--publish` (Mino's call) creates the GitHub release. Linux updater mode = notify (same as mac), deliberate.
- Delete: main-v2.cjs, setup.sh (dead under `set -e`), run-cli.sh, `@anthropic-ai/claude-code` dependency (after grep), stale docs; the six merged local branches (confirm-first list in the PR).

**P3 — One runtime path (L).** `supervisor.mjs` is the only lane on all three. Delete run.sh's loop, `SUPERVISOR_LANE`, `BASH_BIN`, the four lane routers in main.cjs; repoint attach-bootstrap.sh. Stop semantics per platform inside the supervisor (POSIX: SIGTERM + STOPFLAG wait, then KILL; win: STOPFLAG grace so lane `shutdown()` runs, then `taskkill /T`). Port the bash lane's backoff / KST reset / `.agent-failed.json` parity. New shared modules: `proc.cjs` (readCommandLine, sweepByPattern, killTree, gracefulStop, resolveOnPath+PATHEXT — replaces five copies), `data-home.cjs` (`AGENT_DATA_HOME || MEM || ~/Documents/<name>`, honored by memory/service.mjs, hooks, bootstrap, http-server, attach-topology), `localDate()` honoring `AGENT_TZ` (seven Asia/Seoul sites), `installParentDeathExit()` for slack/telegram/calendar/memory servers, portable shutdown ack (no `touch`), window-all-closed no longer kills the agent on win/linux. Drop Claude-CLI gates from the dsh start path; stall watchdog moves into the lane.

**P4 — Platform capability layer in onboarding (L).** `onboarding/platform.cjs` — one table {managedInstall: darwin&&arm64, claudeCliInstall, inAppUninstall, permissionsPanel, attachTopology, sudo, windowMaterial, calendarMcp, binCandidates, spawnBin, killTree} served via `/api/config` + `<meta host-capabilities>`. Frontend three-way copy table (mac/win/linux, `IS_LINUX`); danger zone / sudo card / blur gated on server flags; per-platform uninstall plans (linux: DATA_HOME + ~/.config/Scheherazade + claude projects slug + `$APPIMAGE`; win: NSIS uninstaller); `resolveBin` + one `spawnBin` with Linux dirs (/usr/bin, ~/.local/bin, /snap/bin, npm prefix) and `.cmd` handling; harness artifacts per platform (no bash helpers or Mach-O tmux written on Windows); permission probes as per-platform tables; retire dormant ensureOllamaDaemon; model catalog single source (`.cjs` dual export carrying contextWindow). Windowshot on Linux (xdotool/import) = optional, last.

**P5 — Structural, after 0.3.0 (0.3.x).** channel-core + thin transports (also fixes real gaps: slack/telegram never tick schedules.json, no autonomy night, no shutdown letter, orphaned MCP children on win); lane-common.mjs (headless/dsh duplicate helpers); main.cjs split (claude-cli / codex-proxy / supervisor-control / attach-lane / channel-credentials); http-server.cjs split (vault / provider-validate / cli-drivers / model-catalog); memory/service.mjs split. No platform payoff → off the 0.3.0 critical path.

## Release 0.3.0

Cut with the release-all driver from main; D-73 both-box E2E (mac + magi-win schztest rig) + Linux xvfb boot smoke in WSL; publish is Mino's call. Version 0.2.20 → 0.3.0 (runtime lane change + installer content change).

## Risks

- P3 changes what runs on mac today (bash → node supervisor). `SUPERVISOR_LANE=node` already works on POSIX and is test-covered; no bash escape hatch is kept (it would keep run.sh alive). Fix forward on E2E.
- node-pty removal drops the pty fallback login; only in-app OAuth + token paste remain. Worker confirms the paste path exists before deleting.
- Test relocation touches ~85 files + test-packaging graph gates; mechanical, runner green before and after in one PR.
- Linux runtime beyond boot (Secret Service keyring for safeStorage, bwrap for the sandbox) stays "unsupported with honest UI" in 0.3.0.

## Order and estimate

P1 → P2 → P3 → P4 (P4 may run in parallel with P3 in a separate worktree — disjoint files), then 0.3.0 when both-box E2E + Linux smoke are green. P1+P2 tonight, P3+P4 through 09-08.
