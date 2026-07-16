# v0.0.16 design: attach topology (agent outside the app)

> Status: PROPOSAL, awaiting Mino read. Author: Idea (PO). 2026-07-16.
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
2. Bootstrap: launchd user agent plist starting `tmux new-session -d`
   with run.sh; app detects/attaches on launch; falls back to current
   spawn lane if no session found (feature-flagged, reversible).
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
