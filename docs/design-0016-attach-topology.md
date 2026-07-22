# v0.0.16 design: attach topology (agent outside the app)

> Status: O2 BUILT on branch `feat/attach-topology` (Mino ordered 20:53
> "Tmux로 리팩토링한버전 준비 바로", + 20:55 sudo containment). Tests
> 35/35 attach suite + 344 regression green. Gated remainder: bootstrap
> attribution blessing on 춘식 (probe step3, Mino's hands) — see §As
> built. Author: Idea (PO). 2026-07-16.
> Trigger: live TCC bite 2026-07-16 11:26 KST — Screen & System Audio
> Recording toggle ON in System Settings, yet 0.0.15 denied. Root cause:
> ad-hoc signature. TCC stores a code requirement (csreq) keyed to the
> granting build's cdhash; every release changes the cdhash, so every
> release orphans every TCC grant while the Settings row still shows ON.
> Mino direction (11:29): "멜키오르나 너는 내 맥 권한 tmux attach같은걸로
> 받아가서 나보다 권한 많잖아. 세헤라자드도 비슷한 방식으로."

## Problem statement

The TCC permission subject today is Scheherazade.app itself (the agent
runtime is a child of the app: main.cjs spawns run.sh/supervisor.mjs, so
the whole process tree inherits the app's code identity). With ad-hoc
signing and a near-daily release cadence, ALL TCC grants (screen recording,
mic, Full Disk Access, Automation) break on every install. The permission
subject must be an identity that survives our release cadence.

## Options

### O1 — Developer ID signing (keep spawn topology)
Stable cert-based identity; grants survive updates (this is why iTerm
never re-asks). Cleanest fix, already scoped 07-15/16: $99/yr + the 명의
(개인 vs CHOAM 법인) decision is the prerequisite and corporate paperwork
is the critical path. **Mino deferred this 07-16 09:57 (cadence-first).**
Not blocked by this doc; composes with O2 when the revisit trigger fires.

### O2 — Attach topology (Mino's direction) ← RECOMMENDED
Agent runtime lives in an external tmux session (bootstrapped by a launchd
user agent or by the user's terminal, like the MAGI fleet today). The app
becomes a thin attach client: input via `tmux send-keys`, output via
control mode (`tmux -CC`) or `pipe-pane`; the existing supervisor/PIDFILE
+ HTTP seams in main.cjs already give us most of the transport.

Wins:
- **Permission stability**: TCC subject = host (tmux/terminal), not our
  per-release binary. App updates stop touching grants. Kills today's
  bug class permanently.
- **Session survival**: app crash/update/quit no longer kills the agent;
  reattach on next launch. Big at our release cadence.
- **No native ABI**: the PTY-spawn variant would have needed node-pty
  (native module), against the repo's existing no-native-ABI stance
  (main.cjs:294 ELECTRON_RUN_AS_NODE probe-verified lane).

Costs / caveats (honest):
- tmux server is ITSELF a TCC subject once it daemonizes. A brew-signed
  tmux gets a fresh ad-hoc signature on every `brew upgrade tmux` — same
  stale-grant class, at much lower frequency (tmux upgrades are rare vs
  our daily releases). Net win, not a free lunch.
- Two-process lifecycle: who starts/restarts the agent session? Needs a
  launchd plist (KeepAlive) or documented manual bootstrap. Onboarding
  gains one step.
- Attribution nuance: for a process inside tmux, the TCC responsible
  process is generally the tmux server, NOT the terminal the user
  attached from. Which Settings row actually receives the prompt must be
  **probed, not assumed** (see implementation step 1).

### O3 — App-owned persistent runtime (middle path)
App installs a runtime once to `~/Library/Application Support/Scheherazade/
runtime/` and NEVER overwrites it on app update; launchd spawns the agent
from there. Identity stable across app releases; changes only when we
deliberately update the runtime (controlled, explicit re-grant moments).
No tmux dependency, but we own more plumbing and re-invent what tmux gives
free (attach, persistence, multiplexing). Fallback if O2's tmux dependency
bothers anyone.

## Honesty note on input injection
The previous v0.0.16 candidate (app spawns agent as child PTY, owns the
master fd) ALSO solved input injection without TIOCSTI/SIP. So input
injection is NOT a differentiator between spawn-PTY and attach — the real
differentiators are permission stability, session survival, and ABI
avoidance. (Correcting my own 11:30 channel message which listed it as one
of three wins; it was one of three conveniences, two differentiators.)

## Implementation sketch (only if O2 approved)
1. **Attribution probe first (10 min, on 춘식)**: run `screencapture -x`
   inside (a) tmux under launchd, (b) tmux attached from iTerm — record
   which Settings row appears / which subject gets the grant. Design the
   bootstrap around the observed attribution, not the assumed one.
   → Rehearsed on MAGI host 2026-07-16 + 춘식 paste kit + outcome matrix:
   `docs/probe-0016-attribution.md`. Key rehearsal findings: denied
   captures return exit=0 (judge by image content); terminal-descended
   tmux attributes to the terminal app; launchd-bootstrapped brew tmux
   gets NO grantable Settings row; the app must never bootstrap the
   session outside the legacy fallback lane.
2. Bootstrap: ~~launchd user agent plist~~ **REVISED by step-1 rehearsal:
   launchd-bootstrapped tmux gets NO grantable Settings row, so launchd is
   dead as a bootstrap lane.** Bootstrap = user runs a rendered script in
   their OWN terminal (terminal-descended = blessed attribution lane); app
   detects/attaches on launch; falls back to current spawn lane if no
   session found (config-flagged, reversible).
3. Transport: keep existing HTTP/PIDFILE seams where they already work;
   add send-keys/capture only for the interactive TTY surface.
4. Migration: current spawn lane stays as fallback for one release.

## Open questions (for Mino / next session)
- Which features actually need which TCC? Inventory first (screen
  recording is for what surface — agent seeing the screen? system audio
  for transcription?). Grants we don't need, we don't chase.
- Is tmux present on 춘식 via brew or system? (His message implies he
  already uses tmux attach — unverified, needs one `which tmux`.)
- Does the chat UI transport move to attach too, or only the TTY/agent
  loop? (Scope control: smallest change that kills the permission class.)

## As built (2026-07-16 night, branch feat/attach-topology)

Commissioned by Mino 20:53 ("그냥 기다리지 말고 Tmux로 리팩토링한버전 준비
바로 해줄래?") + 20:55 (sudo password containment). Built overnight under
the 21:03 autonomy grant; deliverable = this branch by morning.

### Invariant (the whole design in one line)
**The app must NEVER cause a tmux server to exist.** A server born from
the app re-keys TCC attribution to the per-release ad-hoc signature —
silently, which is worse than the loud failure we have today. Bootstrap
runs in the user's terminal; everything the app does afterwards is client
IPC against an already-running server (allowlist-enforced in code:
`new-session`/`start-server` are banned verbs in attach-topology.cjs).

### Pieces
- `attach-topology.cjs` — safe-verb allowlist IPC (`-L scheherazade`),
  session state probe, respawn-pane lane, bootstrap command renderer.
- `onboarding/templates/attach-bootstrap.sh` — rendered per-boot into
  DATA_HOME; user runs it in their terminal. Sets `exit-empty off` +
  `remain-on-exit on` (live-verified: server survives pane death and
  session kill), pipes pane output to logs/agent.log, writes pane_pid to
  PIDFILE, bakes CLAUDE_BIN + SUDO_ASKPASS. Refuses if a spawn-lane
  supervisor is alive.
- main.cjs attach lane — `AGENT_TOPOLOGY=attach` branches spawn to
  adopt/respawn/bootstrap-needed (3 outcomes); stop/restart confirm death
  via PIDFILE identity poll (the old handle-wait is vacuous in attach
  mode); app quit leaves the agent alive; log tail feeds the in-app viewer.
- Settings UI — topology select (intent) + state line (reality) + copyable
  bootstrap command card. The app hands out the line, never runs it.
- sudo askpass (P4 spec) — password in safeStorage vault
  (storeProviderKeyVerified round-trip), decrypted ONLY in
  GET /api/sudo/password behind a double gate (per-boot random token file
  0600 + SUDO_ENABLED toggle, default OFF). Helper curls with --max-time
  10. Honest boundary: sudo works only while the app runs.

### Live receipts (isolated-socket probes, this session)
- `has-session` on a dead socket: exit 1, no server, no socket file.
- Pane from `new-session -d "ENV=... exec bash run.sh __loop"` passes both
  is_our_supervisor signature checks.
- Default `exit-empty on` KILLS the server with the last session — the
  bootstrap's `exit-empty off` is load-bearing, found by probe not docs.
- `respawn-pane` revives the ORIGINAL command with a fresh pid → model
  swap works because run.sh re-sources .agent-config.

### Tests
`scripts/test-attach-topology.mjs` 35/35 (no-server-spawn invariant, live
lifecycle on isolated socket, 16 template/wiring tripwires, sudo helper
e2e) + full regression 344 green (supervisor 125, packaging 36, hooks-port
61, channel-connect 19, log-buffer 33, context-gauge 28, journal 35,
hook-lane-path 7).

### Still gated (honest remainder)
- Probe step3 on 춘식 (Mino's hands): confirm the terminal-descended
  bootstrap's attribution blessing on his machine. The BODY of this work
  is step3-independent; only the bootstrap lane's grant behavior awaits it.
- Chat UI transport stays on the existing HTTP seams (scope control —
  smallest change that kills the permission class). send-keys interactive
  surface = not in this cut.

## Review (2026-07-22 night, Idea — PO gate on d3bd707)

Method: direct read of attach-topology.cjs / both templates / main.cjs +
http-server.cjs hunks; test suite re-run TONIGHT (35/35, including the live
negative control: has-session on a dead socket leaves no socket file and no
server process); plus a context-stripped model-divergent blind review
(gemini-3.6-flash-high via agy-exec, code sent raw, no findings pre-seeded).

**Verdict: PASS — merge-ready from the review side.** The invariant holds
mechanically (allowlist + throw-before-tmux + real negative-control test;
blind reviewer independently concurred "HOLDS"). Sudo lane is sound within
its stated boundary: loopback-only bind (`listen(0,'127.0.0.1')`,
http-server.cjs:3653), randomBytes(32) hex token matching the askpass sed
format, 0600 + chmod backstop, fail-closed null token, toggle read
per-request. Probe step3 (춘식) remains the only external gate — unchanged.

### Follow-up cards (none blocking)
1. **Adopt-identity guard** (med-low, real UX path): attachStartFromSession
   adopts `state.panePid` on socket+session name alone — no
   `isOurSupervisor()` check (asymmetric with the PIDFILE-adopt path, which
   verifies). A user's manual `tmux -L scheherazade new -s agent` decoy —
   or plain experimentation — gets adopted as supervisor; stop would then
   kill their shell. Same guard also covers the blind reviewer's null-pid
   catch: on transient `list-panes` failure panePid=null flows through the
   live-pane branch and writes literal "null" into PIDFILE. Fix as one
   block: require Number.isInteger(panePid) && isOurSupervisor(panePid)
   after adopt AND after respawn; else bootstrap-needed, loud.
2. **Sudo containment honesty gap** (design conversation, not a code bug):
   the double gate contains ACCIDENT, not the agent itself. The agent (or
   anything it runs, incl. prompt-injected instructions) holds SUDO_ASKPASS
   → endpoint file path → token, and .agent-config is same-user-writable,
   so SUDO_ENABLED=OFF is not agent-proof either. Mechanically, "the value
   never enters chat/transcript surfaces" is policy, not enforcement. Rec:
   (a) amend the containment comment to say so honestly, (b) surface the
   existing fetch-event log as a visible UI event so every consult is
   user-seen. Deeper binding (serving only to a sudo-descended caller) =
   later design if wanted. (Blind-review finding, confirmed against code.)
3. **Allowlist surplus** (hygiene): send-keys / kill-session / set-option /
   list-sessions are in SAFE_VERBS but have zero call sites (grep-verified
   across main.cjs / attach-topology.cjs / http-server.cjs). None can spawn
   a server, so the invariant is intact — but the doc's own scope-control
   line says send-keys is "not in this cut". Trim to the five used verbs;
   re-add per lane as lanes ship.
4. **Hardening pair** (low, one-liners): crypto.timingSafeEqual for the
   askpass token compare (same-machine other-user surface only — bind is
   loopback); unlink-before-write for .sudo-askpass-endpoint.json so the
   0600 mode always applies to a fresh inode (writeFileSync mode is ignored
   on an existing file; today's chmod backstop leaves a microsecond window).
5. **Note**: pipe-pane logFile single-quote injection is theoretical on
   macOS (short names exclude quotes) — escape if ever touched.

### Refuted blind-review claims (kept so they don't resurface)
- "stop/restart completely broken in attach mode (killAgentSupervisor
  no-ops)" — FALSE premise: stopAgentAwaited never routes through
  killAgentSupervisor; it spawns `run.sh stop` (main.cjs:1496-1509), which
  signals the PIDFILE pid externally. The attach early-return is app-quit
  only, exactly as designed. Suite receipt: "stop/restart use attach-aware
  death confirmation" ok.
- "missing startFailurePoll on the adopted-supervisor path" — FALSE:
  present at main.cjs:817 (2026-07-03 backstop fix), outside the diff hunk
  the blind reviewer saw. Both refutations are the hunk-boundary blindness
  class: absence inferred from context lines.
