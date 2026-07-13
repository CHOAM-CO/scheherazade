# run.sh Semantics Inventory — input for the node-pty supervisor port (Phase 1)

> Provenance: produced 2026-07-14 by a context-stripped full-read subagent
> (main loop deliberately did not re-read run.sh in full). Spot-verified
> against raw by Idea before commit: PKILL_PATTERN (run.sh:95), the
> once-per-supervisor env exports + mktemp'd expect script placement
> (run.sh:294-310), the complete auto-answer table (run.sh:338-345), and the
> backoff ladder + uptime reset (run.sh:386-400) — all four matched.
> Unverified rows carry the sub's line receipts; re-check any row before
> treating it as load-bearing in the port.
>
> §11's seven flagged items are PORT DECISIONS, not bugs to silently copy or
> silently fix. Each needs an explicit verdict in supervisor.mjs's design
> notes: replicate / fix / drop, with the reason written down.

# Semantics Inventory — `run.sh`

All line numbers refer to `run.sh` (487 lines) unless another file is named. This is an inventory of actual behavior, not a redesign.

## 0. Scope note — sourced/invoked scripts (one level deep)

`run.sh` invokes no other script directly. It only `source`s a config file:

- `CONFIG_FILE="${AGENT_CONFIG_FILE:-$SCRIPT_DIR/.agent-config}"` (`run.sh:38`), `source "$CONFIG_FILE"` (`run.sh:42`).
- Checked `setup.sh` (the only writer of `.agent-config`): it writes exactly one line, `echo "AGENT_NAME=$AGENT_NAME" > "$CONFIG_FILE"` (`setup.sh:229`). So the sourced file contributes nothing beyond a single `AGENT_NAME=...` assignment — no additional supervision logic to inventory there.
- `setup.sh` and `run-cli.sh` are only *referenced in comments* (`run.sh:14, 26, 44, 82, 300`) as sibling entry points — `run.sh` does not `exec`/call either of them. `run-cli.sh` is a separate, simpler foreground launcher (`exec claude --model ... --name ... --dangerously-skip-permissions`, `run-cli.sh:31-34`) with no daemon/expect/restart logic at all — irrelevant to this inventory except as contrast.
- `main.cjs` (Electron host) is described in comments as the *caller* of `run.sh` (spawns it, pre-exports env, later runs `run.sh stop`), i.e. the relationship runs the opposite direction from "run.sh invokes it" — out of scope per the "sources or invokes" criterion.

## 1. Config/env resolution at startup

- `SCRIPT_DIR` = resolved directory of the script itself (`run.sh:22`).
- `.agent-config` is sourced if present; otherwise the script requires `AGENT_NAME` to already be in the environment or it hard-fails: `exit 1` (`run.sh:40-47`).
- Two supported callers with different filesystem shapes are documented: standalone CLI (`.agent-config` next to `run.sh`) vs. Electron-bundled launcher (`main.cjs` pre-exports `AGENT_NAME`/`CLAUDE_BIN`/`MODEL`/`AGENT_DATA_HOME` directly, no config file needed) (`run.sh:23-37`).
- Defaults resolved after config load:
  - `MEM="${AGENT_DATA_HOME:-$HOME/Documents/$AGENT_NAME}"` (`run.sh:49`)
  - `MODEL="${MODEL:-claude-opus-4-6}"` (`run.sh:50`)
  - `CLAUDE_BIN="${CLAUDE_BIN:-claude}"` (`run.sh:51`)

## 2. Process lifecycle

- Three dispatch modes via `case "${1:-start}"` (`run.sh:479-487`): `start` → `start_agent`, `stop` → `stop_agent`, `__loop` → `run_loop` (internal, undocumented in the usage string at `run.sh:484`), anything else → usage message + `exit 1`.
- **start_agent()** (`run.sh:416-436`):
  1. `require_claude` — fails fast if `$CLAUDE_BIN` not on PATH (`run.sh:115-120, 417`).
  2. If `PIDFILE` exists and `is_our_supervisor(pid)` passes → already-running, `exit 0` (`run.sh:418-420`).
  3. Else if `PIDFILE` exists but fails identity check → treated as stale, removed (`run.sh:421-427`).
  4. Removes `STOPFLAG`, clears failure marker, ensures `$MEM/logs` exists (`run.sh:428-430`).
  5. Backgrounds a fresh supervisor: `nohup "$SCRIPT_DIR/run.sh" __loop >> "$LOGFILE" 2>&1 &` (`run.sh:431`), records `$!` into `PIDFILE` (`run.sh:432`), `disown`s it (`run.sh:433`), sleeps 1s, prints status (`run.sh:434-435`).
- **run_loop()** (`run.sh:281-414`) — the actual supervisor body, executed only under `__loop`. Runs an infinite `while true` restart loop around one `run_expect()` invocation per iteration (`run.sh:358-413`), described in §4.
- **stop_agent()** (`run.sh:438-477`) — see §7 (kill semantics).
- `PIDFILE` (`$MEM/.agent.pid`) always holds the PID of the backgrounded `run.sh __loop` bash process (the outer supervisor), never the `expect` process or the `claude` leaf's PID (`run.sh:65, 431-432`).

## 3. Identity/liveness verification

- **`is_alive(pid)`** (`run.sh:122-124`): pure `kill -0`. Explicitly documented as identity-blind — proves *a* process holds the PID, not that it's *this* agent's supervisor (`run.sh:126-141` comment).
- **`is_our_supervisor(pid)`** (`run.sh:164-174`): liveness (`is_alive`) **and** identity — reads full command line via `ps -ww -o command= -p "$pid"` (`run.sh:168`) and requires the contiguous substring `"$SCRIPT_DIR/run.sh __loop"` (`run.sh:171`). Fails safe: any `ps` error, empty output, or non-matching command line → "not verified", never trusted as already-running and never force-killed (`run.sh:138-141`).
  - `-ww` is required to defeat BSD/macOS `ps`'s default truncation of long command lines, which would otherwise sever `__loop` off the end (`run.sh:145-151`).
  - Match is one contiguous substring test (not two independent substring tests) specifically to avoid false positives from a recycled PID whose argv happens to contain the script path and `__loop` in unrelated places (`run.sh:152-163`).
- **This identity verification is applied only to the outer `__loop` supervisor PID** — see §7/§11-1 for the finding that the inner `claude` leaf process gets *no* identity verification at all, only blind pattern-based killing.
- Used at: `start_agent` no-op check (`run.sh:418`), `start_agent` stale-PIDFILE cleanup (`run.sh:421-427`), `stop_agent` pre-kill gate (`run.sh:444-451`), `stop_agent` pre-force-kill re-check after the 15s poll (`run.sh:462-474`).

## 4. Restart loop, backoff, and time-based resets

Loop body per iteration (`run.sh:358-413`):

1. If `STOPFLAG` exists → remove `STOPFLAG` + `PIDFILE`, log, `exit 0` (`run.sh:359-363`).
2. **KST date-rollover reset**: compute `CURRENT_KST_DATE` via `TZ=Asia/Seoul date +%Y-%m-%d`; if different from `LAST_KST_DATE`, log, reset `RESTART_COUNT=0`, update `LAST_KST_DATE` (`run.sh:365-370`). Evaluated once per loop iteration only — i.e. only re-checked when the previous `run_expect` call has already returned, not while a session is actively running.
   - **Flag**: unlike the uptime-based reset, this path does **not** call `clear_failure()` — only `RESTART_COUNT` is zeroed. See §11-6.
3. Defensive cleanup: `pkill -f -- "$PKILL_PATTERN" 2>/dev/null || true` (`run.sh:372`) — blind kill of any stray leaf from a previous unclean iteration, before spawning a new one.
4. `STARTED="$(date +%s)"` (`run.sh:373`), then `run_expect "$EXPECT_SCRIPT"` under `set +e`/`set -e` bracketing so a nonzero exit doesn't abort the loop under `set -euo pipefail` (`run.sh:375-378`).
5. Re-check `STOPFLAG` again after `run_expect` returns (`run.sh:380-384`) — this is how a stop request during an active session is actually observed (see §7).
6. `UPTIME=$(( $(date +%s) - STARTED ))` (`run.sh:386`).
7. **Uptime-based reset**: if `UPTIME > 300` (5 minutes) → `RESTART_COUNT=0` **and** `clear_failure()` (`run.sh:387-389`); else `RESTART_COUNT=$((RESTART_COUNT + 1))` (`run.sh:391`). [SPOT-VERIFIED raw]
8. **Backoff ladder** selected from `RESTART_COUNT` (`run.sh:394-400`): `0|1 → 5s`, `2 → 10s`, `3 → 20s`, `4 → 40s`, else (`5+`) `→ 120s`. [SPOT-VERIFIED raw] Comment at top of file documents this as a deliberately simpler ladder than MAGI's own 3/30/120/300/600 (`run.sh:6-9`).
9. **Quick-fail failure marker**: if `RESTART_COUNT >= 3`, calls `write_failure(...)` with a fixed-template reason string embedding `RESTART_COUNT`, last `UPTIME`, and `EXIT_CODE` (`run.sh:402-409`). Re-written every re-trigger so `since`/`reason` stay current.
10. Logs exit code/uptime/restart#/backoff, then `sleep "$BACKOFF"` (`run.sh:411-412`), loop repeats.

**`write_failure(reason)`** (`run.sh:196-232`):
- Writes `$MEM/.agent-failed.json` = `{"status":"failed","code":"crash_loop","reason":"...","since":"<UTC ISO8601>"}` (`run.sh:224-225`).
- `code` is hardcoded literally to `"crash_loop"` (one call site only) (`run.sh:190-195, 224`).
- JSON-escapes `reason` in strict order: `\` → `\\`, then `"` → `\"`, then `\n`, `\r`, `\t` (`run.sh:207-211`) — order matters (backslash first) to avoid double-escaping.
- Atomic write: `mktemp "${FAILFILE}.XXXXXX"` (falls back to `${FAILFILE}.tmp$$` if `mktemp` fails) then `mv -f` onto `FAILFILE` (`run.sh:212-213, 230`).
- Best-effort under `set -e`: any write/rename failure is logged and swallowed (`return 0`), never aborts the loop (`run.sh:214-231`).

**`clear_failure()`** (`run.sh:234-236`): `rm -f "$FAILFILE"`, errors ignored. Called at fresh loop start (`run.sh:356`), on the uptime-based reset (`run.sh:389`), and in `start_agent` (`run.sh:429`).

## 5. Timeouts

- **`SESSION_TIMEOUT`** (`run.sh:102`, default `43200` = 12h): ceiling on one `run_expect()` invocation (one `claude` session lifetime under supervision), enforced inside `run_expect()` (`run.sh:238-279`), not by `run_loop` itself.
- Preferred path: real `timeout`/`gtimeout` if present on PATH (`run.sh:103-109`):
  `"$TIMEOUT_BIN" --kill-after=10 --signal=TERM "$SESSION_TIMEOUT" /usr/bin/expect -f "$script"` (`run.sh:256`) — SIGTERM to the whole child process group at `SESSION_TIMEOUT`, SIGKILL after a further 10s grace. Chosen because `timeout(1)` puts its child in its own process group, so signaling the group reaches `expect` and whatever it spawned together (`run.sh:240-248`).
- Fallback (no `timeout`/`gtimeout` — stock macOS ships neither) (`run.sh:100-101, 260-278`): manual watchdog.
  - `/usr/bin/expect -f "$script" &`, `cmd_pid=$!` (`run.sh:260-261`).
  - Background subshell: `sleep "$SESSION_TIMEOUT"`; if `cmd_pid` still alive, `pkill -TERM -P "$cmd_pid"` (children first — a dead parent's children get reparented too fast to find by ppid afterward, per comment `run.sh:246-248`), then `kill -TERM "$cmd_pid"`, `sleep 10`, then `pkill -KILL -P "$cmd_pid"` and `kill -KILL "$cmd_pid"` (`run.sh:262-271`).
  - Main flow: `wait "$cmd_pid"` captures `exit_code`; the watchdog subshell is then itself reaped via `pkill -P`, `kill`, `wait` regardless of whether it fired (`run.sh:272-278`).
  - **Note**: plain `cmd &` in bash does *not* get its own process group (verified empirically per comment, `run.sh:243-245`), so this fallback cannot do a safe group-wide kill — hence the PID-parentage (`-P`) approach.
- **Per-prompt `expect` timeout = 25s** (`set timeout 25`, `run.sh:320`): governs only the initial onboarding-prompt-matching phase (§6). `exp_continue` after each successful match resets the 25s window. If 25s elapses with no known prompt, the `timeout {}` branch fires (no-op) and control falls out of the `expect{}` block entirely (`run.sh:344`).
- After that: `trap exit {SIGTERM SIGINT}` (`run.sh:346`), `set timeout -1` (`run.sh:347`), `expect eof` (`run.sh:348`) — waits indefinitely. **The 5 auto-answer patterns are only watched during the initial window** — see §11-4.

## 6. Expect prompt auto-answers — exact receipts [SPOT-VERIFIED raw]

Static heredoc template, single-quoted (`<<'EXPECT_EOF'`, `run.sh:311`) so all `$env(...)` references are literal Tcl, resolved by `expect` at runtime from the process environment — not bash-substituted at file-creation time. Full block: `run.sh:311-349`.

Spawn line (`run.sh:319`):
```
spawn -noecho $env(CLAUDE_BIN) --model $env(MODEL) --name $env(AGENT_NAME) {*}$extra_args --dangerously-skip-permissions --dangerously-load-development-channels server:agent-channel
```
- `-noecho` suppresses local echo of injected `send` keystrokes (not of the program's own output — `log_user 1` at `run.sh:312` keeps that visible in `LOGFILE`).
- `extra_args` conditionally includes `--append-system-prompt-file $env(SYSTEM_PROMPT_FILE)`, only if `SYSTEM_PROMPT_FILE` is set (`run.sh:305-307, 315-318`).
- `stty_init "rows 50 cols 200"` (`run.sh:314`) fixes the pty size.
- `set env(TERM) xterm-256color` (`run.sh:313`).

Auto-answer table, `expect { ... }` block at `run.sh:338-345` (all patterns Tcl `-re`, **case-sensitive**, unanchored, no `-nocase`):

| Match pattern (exact) | Response sent (exact) | Trailing CR? | Loops? |
|---|---|---|---|
| `-re "trust"` | `send "\r"` | Yes (bare CR) | `exp_continue` |
| `-re "confirm"` | `send "\r"` | Yes (bare CR) | `exp_continue` |
| `-re "local development"` | `send "\r"` | Yes (bare CR) | `exp_continue` |
| `-re "text style"` | `send "\r"` | Yes (bare CR) | `exp_continue` |
| `-re "Do you want to use this API key"` | `send "1"` | **No** — bare `"1"`, no `\r` | `exp_continue` |
| `timeout` (25s idle) | *(empty action `{}`)* | — | falls through, no `exp_continue` |

- The API-key case is the only one with documented empirical backing (`run.sh:321-337`): real dialog is `"Do you want to use this API key? 1. Yes  2. No (recommended)"`, and it is **not** suppressed by `--dangerously-skip-permissions`. The comment records the exact reproduced failure of sending `"1\r"`: `"1"` is a hotkey that fires the confirm handler, while `"\r"` independently selects the *default focus*, which is "No" — sending both writes the key into approved-and-rejected state at once (re-triggers the freeze). Empirically: `"1"` alone → approved 3/3; `"1\r"` → both states hit 2/2. **Bare `"1"` with no trailing `\r` is load-bearing, not a typo.**
- The other four patterns carry **no comment** identifying which literal dialog each targets, nor why `\r` is correct for all four — see §11-3.

## 7. Signal handling & kill semantics

Two different, differently-scoped kill mechanisms for two different targets:

**A. The outer `__loop` supervisor (tracked in `PIDFILE`)** — identity-verified before any kill (see §3):
- `trap 'log "signal received, exiting loop"; rm -f "$PIDFILE"; exit 0' TERM INT` at start of `run_loop()` (`run.sh:282`). Fires only on a direct signal to this bash process. **Removes only `PIDFILE`, not `STOPFLAG`, and does not kill live descendants** — see §11-7.
- `stop_agent()` (`run.sh:438-477`) never signals the `PIDFILE` PID directly with TERM/INT. Sequence:
  1. Verify `PIDFILE` + `is_our_supervisor(PID)` — else clean up as stale, exit 0 (`run.sh:439-451`).
  2. `touch "$STOPFLAG"` (`run.sh:454`) — cooperative, only observed between loop iterations.
  3. `pkill -f -- "$PKILL_PATTERN"` (`run.sh:455`) — what actually unblocks a live session: kills the `claude` leaf, `expect eof` returns, loop reaches its post-call `STOPFLAG` check and exits cleanly.
  4. Poll `is_alive(PID)` 1/s up to 15s (`run.sh:457-460`); on death, remove `STOPFLAG`, exit 0.
  5. If still alive after 15s: **re-verify identity** (`run.sh:469`) before `kill -KILL "$PID"` (`run.sh:471`) — 15s is enough for PID recycling. If not verified: skip the direct kill, rely on pattern `pkill` (`run.sh:473-474`).
  6. Final: `pkill -f -- "$PKILL_PATTERN"` again, remove `PIDFILE`/`STOPFLAG` (`run.sh:475-476`).

**B. The inner `claude` leaf (and its `expect` wrapper) — NO identity verification**, only blind pattern or parentage matching:
- `PKILL_PATTERN="--name ${AGENT_NAME}"` (`run.sh:95`) [SPOT-VERIFIED raw] — bare substring matched system-wide by `pkill -f`. Used at: pre-spawn cleanup (`run.sh:372`), `stop_agent` primary kill (`run.sh:455`), final cleanup (`run.sh:475`).
  - Pattern deliberately excludes `--model $MODEL` (mutable) and `$CLAUDE_BIN` (can't join across the variable `--model` segment) — anchored only on the stable `--name ${AGENT_NAME}` tail (`run.sh:69-95`).
  - `pkill -f -- "$PKILL_PATTERN"`: `--` required because the pattern itself starts with `--`.
- Manual-watchdog fallback: `pkill -TERM/-KILL -P "$cmd_pid"` (`run.sh:265, 268`) — parentage-scoped, still no identity check.
- Net: **the claude leaf has no equivalent of `is_our_supervisor()`** — see §11-1.

**Tcl-level trap inside the expect script**: `trap exit {SIGTERM SIGINT}` (`run.sh:346`), installed only *after* the onboarding phase, so `expect` exits promptly on TERM/INT instead of blocking in `expect eof`.

## 8. Environment variables

**Consumed:**
| Var | Where | Default if unset |
|---|---|---|
| `AGENT_CONFIG_FILE` | `run.sh:38` | `$SCRIPT_DIR/.agent-config` |
| `AGENT_NAME` | `run.sh:43, 47` | none — hard fail if absent after config load |
| `AGENT_DATA_HOME` | `run.sh:49` | `$HOME/Documents/$AGENT_NAME` |
| `MODEL` | `run.sh:50` | `claude-opus-4-6` |
| `CLAUDE_BIN` | `run.sh:51` | `claude` |
| `EFFORT_LEVEL` | `run.sh:60` | `high` (sets `CLAUDE_CODE_EFFORT_LEVEL`) |
| `STREAM_IDLE_TIMEOUT` | `run.sh:61` | `300000` ms (sets `CLAUDE_STREAM_IDLE_TIMEOUT_MS`) |
| `AUTO_COMPACT_WINDOW` | `run.sh:62` | `500000` (sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW`) |
| `AUTOCOMPACT_PCT` | `run.sh:63` | `80` (sets `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) |
| `SESSION_TIMEOUT` | `run.sh:102` | `43200` s (12h) |
| `TMPDIR` | `run.sh:309` | `/tmp` |

**Set/exported by the script:**
- The four `CLAUDE_*` derived vars — exported unconditionally at top level (`run.sh:60-63`), before dispatch.
- `AGENT_NAME MEM CLAUDE_BIN MODEL` — exported once inside `run_loop()` before the `while` loop (`run.sh:297`) [SPOT-VERIFIED raw]. **Once per supervisor lifetime, not per restart** — see §11-5.
- `SYSTEM_PROMPT_FILE` — conditional, only if `$MEM/system_prompt.md` exists at loop start (`run.sh:305-307`) [SPOT-VERIFIED raw], also once.
- `env(TERM)` = `xterm-256color` inside the Tcl script (`run.sh:313`).

## 9. Filesystem paths touched

| Path | Purpose | Receipt |
|---|---|---|
| `$SCRIPT_DIR/.agent-config` (or `$AGENT_CONFIG_FILE`) | sourced config | `run.sh:38, 42` |
| `$MEM/.agent.pid` (`PIDFILE`) | outer supervisor PID | `run.sh:65` |
| `$MEM/logs/agent.log` (`LOGFILE`) | append-only sink for the whole `__loop` (no rotation anywhere) | `run.sh:66, 431` |
| `$MEM/.stop_requested` (`STOPFLAG`) | cooperative stop signal, checked between iterations only | `run.sh:67, 359-363, 380-384, 454` |
| `$MEM/.agent-failed.json` (`FAILFILE`) | quick-fail marker, JSON | `run.sh:68, 196-232` |
| `$MEM/system_prompt.md` | optional custom system prompt, read once at loop start | `run.sh:305-307` |
| `$MEM/logs/` | `mkdir -p` in both `start_agent` and `run_loop` | `run.sh:284, 430` |
| `${TMPDIR:-/tmp}/agent-portable-expect.XXXXXX` (`EXPECT_SCRIPT`) | mktemp'd expect script, written once per supervisor lifetime, removed via `EXIT` trap | `run.sh:309-310` |
| `${FAILFILE}.XXXXXX` (or `.tmp$$`) | scratch for atomic `write_failure` | `run.sh:212-213` |

## 10. macOS-specific assumptions

- `ps -ww -o command= -p "$pid"` — BSD/macOS `ps` truncation quirk, `-ww` is the fix (`run.sh:126-163, 168`). Windows lane: `tasklist` / `Get-CimInstance Win32_Process`.
- `timeout`/`gtimeout` preference + manual-watchdog fallback because stock macOS ships neither (`run.sh:97-109`).
- Hardcoded `/usr/bin/expect` (`run.sh:256, 260`) — stock on macOS; does not exist on Windows at all (the whole reason for the node-pty port).
- Top-of-file comment references macOS TCC as deferred setup (`run.sh:13-14`) — not executed here.
- `TZ=Asia/Seoul date` (`run.sh:112, 352, 365`) — tzdata-dependent, portable in Node via Intl.

## 11. Flagged — accidental, buggy, or unverified (PORT DECISIONS, one verdict each)

1. **Leaf process has zero identity verification.** Outer supervisor gets two-stage `ps` identity checks; the `claude` leaf is only ever killed by blind system-wide `pkill -f` substring or parentage `pkill -P`. Documented as accepted tradeoff (`run.sh:69-95`) but asymmetric. Node port holds a real child handle — the port can kill by handle and drop the blind pattern kill entirely (keep a pattern sweep only for orphan cleanup at startup).
2. **`EXIT_CODE` may not reflect the real `claude` exit status.** The expect script never `wait`s after `expect eof` before falling off the end, so the captured code may be expect's own near-always-0. Consistent with the fact that nothing branches on `EXIT_CODE` — only `UPTIME` drives restart decisions. Node port gets real exit codes for free; decide whether to start USING them or keep uptime-only semantics (uptime-only is the battle-tested behavior).
3. **4 of 5 auto-answer patterns are undocumented** (`trust`, `confirm`, `local development`, `text style`): no recorded dialog text, no validation history, case-sensitive. Port must carry them verbatim AND add test coverage; do not "improve" the regexes blind.
4. **Auto-answer only during the initial ≤25s-idle window.** After the first 25s gap, pattern matching permanently stops for that session (`expect eof`, infinite). A prompt reappearing mid-session is NOT auto-answered. Port decision: replicate the one-shot window or watch for life-of-session. Replicating is the conservative default; life-of-session watching changes behavior (e.g. a stray "trust" in ordinary output would fire a CR into the session — the 25s window is accidentally a safety feature. Lean replicate).
5. **Env for the expect template is computed once per supervisor lifetime, not per restart.** Dropping a new `$MEM/system_prompt.md` while the supervisor runs has no effect until full stop/start. Known consumer impact: model swaps require conf edit + child restart, effort changes require full bounce (matches MAGI fleet ops experience). Port decision: replicate or re-resolve per spawn — re-resolving per spawn is a real improvement candidate, but it CHANGES swap semantics that ops currently rely on; if changed, say so loudly in release notes.
6. **Reset paths are asymmetric**: uptime>300s clears `RESTART_COUNT` + failure marker; KST date rollover clears only `RESTART_COUNT` (`run.sh:365-370` vs `387-389`). Unexplained in comments (most other decisions are explained). Verdict needed: probably keep (a new day doesn't fix a bad token) but write the reason down this time.
7. **The supervisor's TERM/INT trap doesn't reap descendants** (`run.sh:282`): a direct signal to the `__loop` PID orphans the live `expect`/`claude` tree. Latent (stop_agent never uses this path). Node port: a direct-signal handler should get the same cleanup guarantees as the stop command — child handles make this cheap.
