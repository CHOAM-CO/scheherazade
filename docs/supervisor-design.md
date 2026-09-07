# supervisor.mjs — design verdicts (Phase 1, Windows port lane)

> Input: `docs/supervisor-semantics-inventory.md` (828441c). This doc decides;
> the inventory describes. Every claim below that has NOT been executed is
> marked UNVERIFIED with the check that would verify it — reasoning alone has
> a 0/5 record against execution in this repo's own history (see the
> 2026-07-13 red-team notes in the v0.0.6 commits).

## Architecture

- `supervisor.mjs` = standalone script with the same three modes as run.sh
  (`start` / `stop` / `__loop`), same PIDFILE (`$MEM/.agent.pid`, holds the
  `__loop` process pid), same STOPFLAG / FAILFILE paths and JSON shape.
  Rationale: main.cjs already participates in these exact files
  (AGENT_PIDFILE, readPidFromFile + isOurSupervisor mirror, `spawn(BASH_BIN,
  [RUN_SH_PATH, '__loop'])` seam at spawnRealAgentChildLocked) — keeping the
  contract means main.cjs changes are a seam swap, not a redesign.
- Child spawn: node-pty `pty.spawn(CLAUDE_BIN, args, {cols: 200, rows: 50,
  env})` replaces expect. The supervisor holds a REAL child handle — this is
  the structural win over bash (see verdicts 1 and 7).
- Identity verification convention carries over: the contiguous-substring
  signature becomes `supervisor.mjs __loop`. mac lane keeps `ps -ww -o
  command=`; win lane reads `CommandLine` via PowerShell
  `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>"`. Same fail-safe
  posture: unreadable/empty/non-matching = NOT verified, never force-kill.
  - ~~UNVERIFIED~~ → **VERIFIED BY EXECUTION, 2026-08-01 (Idea spike on
    magi-win)**: Get-CimInstance CommandLine from a node child_process,
    3 runs: 405/268/295ms (all <2s), CommandLine present and matching.
    Measured during a CPU-quiet window (coordinated with Skia's REAP run).
    Probe: MAGI tmp_scratch/win-spike/cim-probe.js, node 24.18.1.

## Runtime / ABI (the load-bearing packaging question)

- Packaged app: main.cjs spawns the supervisor with
  `spawn(process.execPath, [SUPERVISOR_PATH, '__loop'], {env: {...,
  ELECTRON_RUN_AS_NODE: '1'}})`. No system-node dependency on either OS;
  the runtime is Electron's own node.
- ~~UNVERIFIED dual-ABI assumption~~ → **VERIFIED BY EXECUTION, 2026-07-14
  — and the design's reasoning was wrong in both directions.** node-pty
  1.1.0 is N-API: ONE npm prebuilt binding passed the probe
  (scripts/probe-pty.mjs) under all four lanes — dev node v24.7 (abi 137),
  dev Electron 43 (abi 148), the packaged app binary against the repo tree,
  and the packaged app binary against the built artifact's unpacked tree.
  No dual build exists; electron-builder rebuild is disabled
  (`npmRebuild: false`) because it only adds a second binary lineage that
  SHADOWS the tested prebuild (node-pty loads build/Release before
  prebuilds/).
- What execution found that reasoning missed (both fatal, neither in this
  doc's original risk list):
  1. **Upstream tarball defect**: node-pty 1.1.0's published tarball ships
     `prebuilds/darwin-*/spawn-helper` WITHOUT the exec bit → every
     pty.spawn dies with `posix_spawnp failed`. Repaired by postinstall
     (scripts/fix-pty-helper.mjs), gated in test-packaging.mjs.
  2. **helperPath double-replace**: `lib/unixTerminal.js` rewrites
     `app.asar` → `app.asar.unpacked` unconditionally; a module loaded
     from an ALREADY-unpacked path (exactly our plain-node-children
     architecture) resolves its helper to `app.asar.unpacked.unpacked` →
     ENOENT → `posix_spawnp failed`. Patched idempotently by the same
     postinstall, gated in test-packaging (repo AND artifact copies).
  - Honest note: the failure was first mis-attributed to the rebuilt
    binding — a plausible story the early split-tests appeared to support,
    dead once repo-tree runs with the same rebuilt binding passed. Recorded
    in the gate comment so the dead cause cannot be re-adopted.
- First native module in the repo — this was a deliberate zero-native
  policy (`node:sqlite` chosen for exactly this). The scoping doc already
  concedes the PTY requirement is structural. test-packaging now gates:
  prebuild present as real file, helper executable, no build/Release
  shadow, helperPath patch present in repo and artifact. 24/24 at close.

> **Amendment 2026-09-07 (design-0023 P2) — node-pty is retired.** Everything
> above stayed true of the shipped supervisor for exactly zero days: the ported
> supervisor.mjs never spawned a pty (it spawns `process.execPath` with
> ELECTRON\_RUN\_AS\_NODE and holds a real child handle, which is the same
> structural win without the native module — see supervisor.mjs's own header).
> The dependency survived on ONE caller, setup-token-session.cjs's pty login,
> which 0.2.18 superseded with in-app loopback OAuth. It has now been dropped:
> `node-pty` is out of package.json dependencies and allowScripts, the
> `postinstall` hook and `scripts/fix-pty-helper.mjs` are deleted,
> `scripts/probe-pty.mjs` is deleted, and test-packaging's node-pty section is
> replaced by a NATIVES gate covering the natives that actually ship (koffi,
> sharp + libvips, @vscode/ripgrep, landlock-run — dsh's, all five unguarded
> the whole time this section called node-pty "the one native module").
> What forced the retirement: node-pty 1.1.0 publishes NO linux prebuild, and
> fix-pty-helper's `rm -rf node_modules/node-pty/build` ran on every platform,
> so on Linux the postinstall deleted the only binding node-gyp had just built.
> dsh's nested node-pty 1.2.0-beta.15 (prebuilds for all six platforms) is
> untouched and still ships.

## The 7 inventory flags — verdicts

1. **Leaf identity (blind pkill)** → FIX. The supervisor kills by child
   HANDLE (pty.kill / taskkill /PID <child> /T /F), which is exact by
   construction. Keep ONE pattern sweep (`--name <AGENT>` substring) only as
   ORPHAN CLEANUP mirroring run.sh:372's pre-spawn sweep — which sits INSIDE
   the while loop (every iteration, pre-spawn), not merely at supervisor
   start as this verdict's first wording said; the port replicates the
   per-iteration placement, and the sweep only ever runs when our own child
   handle is dead. An orphan from a crashed supervisor has no live handle
   anywhere, so the pattern is the only tool that reaches it. stop-path
   blind sweeps (run.sh:455,475) are dropped; the handle replaces them.
2. **Decorative EXIT_CODE** → REPLICATE semantics, record honestly. Restart
   decisions stay UPTIME-ONLY (battle-tested); the real exit code node gives
   us goes into the log and the failure marker reason, clearly labeled, but
   does not drive branching. Changing restart policy is not this port's job.
3. **4 undocumented prompts** → REPLICATE verbatim, case-sensitive, plus a
   fixture test that feeds each literal pattern through the matcher. Do NOT
   improve the regexes. The bare-"1" no-CR quirk for the API-key prompt is
   load-bearing (empirical 3/3 vs 2/2 corruption, run.sh:321-337) and gets
   its own test asserting the response string contains NO carriage return.
4. **25s one-shot auto-answer window** → REPLICATE exactly (25s idle timer,
   window closes permanently for the session after first expiry). The
   window is an accidental safety feature: a stray "trust" in ordinary
   session output must never fire a CR into a live session. The port makes
   it explicit: matcher detaches after the window closes.
5. **Once-per-lifetime env resolution** → REPLICATE for v1. Re-resolving
   per-restart would silently change fleet-known swap semantics ("effort
   changes need a full bounce"). Improvement candidate AFTER the port
   proves itself, as its own loudly-noted change.
6. **Asymmetric resets (KST rollover clears count, not failure marker)** →
   REPLICATE, and write the presumed reason into the code comment: a new
   day resets patience, it does not fix a bad token. If the presumption is
   wrong, the comment makes it findable; silence made it archaeology.
7. **TERM/INT trap orphans descendants** → FIX. The supervisor's signal
   handler kills the pty child (TERM, 10s grace, KILL) before exiting and
   removes PIDFILE. Cheap with a handle; the bash version's gap was a
   limitation, not a design.

## Kill lane per platform

- mac: keep POSIX semantics. pty child TERM → 10s → KILL. Orphan sweep via
  `pkill -f -- "--name <AGENT>"` at start only.
- win: `taskkill /PID <pid> /T /F` for the tree kill; orphan sweep via
  PowerShell `Get-CimInstance Win32_Process | Where CommandLine -match` +
  Stop-Process. No pkill, no ps.
  - ~~UNVERIFIED~~ → **VERIFIED BY EXECUTION, 2026-08-01 (Idea spike on
    magi-win)**: synthetic 3-level node tree (parent 404 → child 24600 →
    grandchild 21272), `taskkill /PID 404 /T /F` killed all three —
    grandchild explicitly reported ("PID 21272 (child process of PID
    24600) has been terminated"), ALIVE-AFTER empty. Caveat kept honest:
    tree was plain node processes, not the real CLI+MCP tree — re-run the
    same driver (tmp_scratch/win-spike/tree-test.ps1) once a live agent
    session exists on win. taskkill also reaped an untracked conhost
    child (10632), consistent with full-tree semantics.
  - Scope note (2026-08-01, comment-sync pass): the spike receipts cover
    the taskkill tree kill and the CIM CommandLine READ. The orphan
    sweep's ACTION (Where-Object -like + Stop-Process) has NOT been
    executed on win — its premise (CommandLine visibility) is verified,
    the sweep itself is not. Verify by leaving a real orphan once a live
    win session exists.

## Session timeout

- One `setTimeout(SESSION_TIMEOUT)` in the supervisor: TERM the pty child,
  10s grace, KILL. Replaces both the gtimeout lane and the manual watchdog
  subshell — a node process with a handle needs neither. The 12h default
  and env override name (`SESSION_TIMEOUT`) carry over unchanged.

## Backoff / resets / failure marker

- Ladder verbatim: 0|1→5s, 2→10s, 3→20s, 4→40s, 5+→120s. Uptime>300s →
  count=0 + clear failure marker. KST rollover (Intl with Asia/Seoul, no TZ
  env games) → count=0 only (verdict 6). write_failure JSON shape and
  atomic tmp+rename carry over; escaping comes free from JSON.stringify.

## What run.sh keeps doing

- run.sh stays the mac production lane until supervisor.mjs has run a full
  real session on BOTH platforms (mac dev + magi-win). The seam in main.cjs
  gets a flag (env SUPERVISOR_LANE=node|bash, default bash) so the swap is
  a config flip with an instant rollback, same shape as the model-revert
  lever in the mute-strike ledger work.

## Test plan (attacks, not demonstrations)

- Matcher: each of the 5 patterns fires its exact response; API-key response
  has no CR; a pattern arriving AFTER window close fires nothing.
- Lifecycle: STOPFLAG between iterations exits cleanly; STOPFLAG during a
  live session takes effect after child death; stale PIDFILE with recycled
  pid is NOT trusted (identity check) and NOT force-killed.
- Backoff: two crashes inside 300s escalate the ladder; a 301s run resets
  it; KST rollover resets count but leaves an existing failure marker.
- Crash-loop marker: 3 quick fails write the JSON with current reason;
  uptime reset clears it.
- Signal: TERM to the supervisor kills the child before exit (verdict 7) —
  assert no orphan by scanning for the child pid after.
- All of these run against the REAL supervisor module with a fake child
  (a script that exits on cue) and a fake clock ONLY for the ladder — the
  mock inventory rule applies: every mock names what it stands in for.
