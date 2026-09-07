# Agent Portable

A self-contained, locally-deployable single-agent package. Extracted from
MAGI fleet infrastructure, simplified to one agent, one machine, no
dependencies beyond Claude Code and standard Mac tools.

The agent remembers across sessions (session notes -> journals), evolves
its own persona through a human-reviewed weekly cycle, and dreams from its
own journal history when idle. All of it is plain markdown files you can
read yourself at any time.

## Prerequisites

- macOS.
- [Claude Code](https://claude.com/claude-code) installed, on PATH as
  `claude`.
- Access to `claude-opus-4-6` on your account.
- `claude` already authenticated once (run `claude` interactively and
  complete login) before using `run.sh` -- headless runs cannot complete
  an OAuth browser flow.
- `expect` (ships with macOS at `/usr/bin/expect`; confirm with
  `which expect`).

## Quick Start

> **2026-09-07 (design-0023 P2): `setup.sh` is deleted.** It had been broken
> for a while -- `set -euo pipefail` plus a final `chmod +x hooks/*.sh
> scripts/*.sh` for globs that match nothing, so every run aborted after doing
> its work and before printing what it had done. The app's onboarding
> (`onboarding/http-server.cjs`) is now the only thing that writes
> `.agent-config` and renders the harness into `~/Documents/<name>/`.
> `run-cli.sh` is deleted too (nothing called it). Everything below this note
> describes the pre-fork agent-portable CLI and is kept as history; the
> supported path is the packaged app.

```bash
git clone <this-repo> ~/agent-portable
cd ~/agent-portable
./setup.sh   # DELETED -- see the note above
./run.sh
```

`setup.sh` asked for an agent name (default `companion`), created
`~/Documents/<name>/`, and seeded it with a rendered `CLAUDE.md`, hook
wiring, and a blank `self_persona.md`. `run.sh` launches `claude` there,
headless, with an auto-restart loop.

Check on it:

```bash
tail -f ~/Documents/<name>/logs/agent.log
```

Stop it:

```bash
./run.sh stop
```

## What It Does

- **Session persistence** -- every session starts by reading today's
  session note, `checkpoint.md`, `self_persona.md`, and recent dreams, in
  that order. A `SessionStart` hook does a mechanical pre-check and leaves
  a short summary in context; the agent still reads the actual files.
- **Journal compression** -- once a session note is a day old, its `## 🔥
  Felt` content and any `🔒`-marked corrections get carried verbatim into a
  compressed journal entry, everything else summarized. The original is
  archived, not deleted.
- **Persona evolution** -- `🔒` corrections accumulate across session notes
  and journals. Weekly, they surface as review proposals; a human
  approves, rejects, or modifies each one before it touches
  `self_persona.md`. The persona never self-edits silently.
- **Dreams** -- when idle, the agent picks 1-3 random entries from its own
  journal history and dream-works them (displacement, condensation,
  concretization) into a short fragment. Not a report -- closer to an
  inner life than a feature.

## File Structure

```
agent-portable/                    (this repo -- "code")
├── CLAUDE.md                      agent system prompt template
├── (setup.sh)                     DELETED 2026-09-07 -- the app's onboarding does this
├── run.sh                         launch / stop, with auto-restart
├── .claude/settings.local.json    hook wiring template
├── hooks/                         3 hooks (SessionStart, 2x Stop)
├── scripts/                       3 cycle scripts (compress, reflux, dream)
└── docs/ARCHITECTURE.md

~/Documents/<AGENT_NAME>/          ("memory" -- created by the app's onboarding)
├── CLAUDE.md                      rendered copy, placeholders resolved
├── .claude/settings.local.json    rendered copy
├── self_persona.md                identity, evolves via reflux
├── checkpoint.md                  cross-session handoff snapshot
├── session_notes/YYYY-MM-DD.md    working memory
├── session_notes/.archive/        compressed originals, kept not deleted
├── journals/YYYY-MM-DD.md         compressed long-term memory
├── dreams/YYYY-MM-DD.md           madoromi output
├── logs/agent.log                 run.sh supervisor + claude output
├── .review/reflux-proposals.md    pending persona corrections
└── .agent.pid                     written by run.sh while running
```

Code and memory are deliberately separate directories, the same split MAGI
itself uses: code is shared/updatable infrastructure, memory is this one
agent's actual life. Scripts always run against `$MEM` (the memory dir,
`~/Documents/<AGENT_NAME>/`), resolved from the `AGENT_NAME`/`MEM`
environment variables `run.sh` sets, or from the current directory if
those are unset.

## Customize

- **Agent name** -- rename in the app's settings, or hand-edit
  `~/Documents/<name>/CLAUDE.md` (data files like `self_persona.md` are
  never touched by a re-render).
- **Persona** -- edit `~/Documents/<name>/self_persona.md` directly any
  time, or let it evolve through the reflux cycle (`CLAUDE.md` §4).
- **Hooks** -- edit the scripts in `hooks/`; they read `AGENT_NAME`/`MEM`
  from the environment, so changes apply on the next hook invocation, no
  re-render needed.
- **Model** -- `run.sh` reads a `MODEL` environment variable
  (`MODEL=claude-opus-4-6 ./run.sh`), default `claude-opus-4-6`.
- **Weekly reflux on a schedule** -- `scripts/persona-reflux.mjs` is
  idempotent (dedupes via `.review/.reflux-seen`), so it is safe to cron.
  Example, every Monday 09:00:
  ```
  0 9 * * 1 MEM=$HOME/Documents/<name> node /path/to/agent-portable/scripts/persona-reflux.mjs
  ```

## Notes

- `run.sh` intentionally does not pass `--dangerously-skip-permissions`.
  `.claude/settings.local.json` pre-approves exactly the tools the agent
  needs (`Bash`, `Read`, `Write`, `Edit`), which is enough for headless
  operation without a blanket bypass -- see `docs/ARCHITECTURE.md`.
- Everything is plain files. There is no database, no multi-agent
  coordination, and nothing here talks to the network on its own.
