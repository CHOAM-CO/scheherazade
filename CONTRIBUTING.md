# Contributing — Scheherazade

Working agreement for this repo. Short on purpose; the repo's real
conventions live in its history — when in doubt, `git log` a similar change.

> File a PR against this file to change the rules themselves.

## Trunk

- **`master` is trunk** and the GitHub default branch (since 2026-07-22;
  before that, history grew as a stack of feature branches and master was
  stale — if an old clone looks ancient, re-pull).
- Clone → `master` = current.

## Branches

- `feat/<slug>` new capability · `fix/<slug>` bug fix · `docs/<slug>`
  docs only · `chore/<slug>` mechanical.
- Slug: short, kebab-case, names the change not the ticket.

## Commits

- Conventional prefix + scope: `feat(attach-topology): ...`,
  `fix(onboarding): ...`.
- **Body carries the design rationale.** This repo's tradition is long,
  honest commit bodies (what/why/receipts, refuted alternatives). Keep it.
- Agent-authored commits carry their `Co-Authored-By:` line.

## Where things live (0.3 P2 — this moved)

| dir | what | ships in the installer? |
|---|---|---|
| `tests/` | every test program, `test-*.{mjs,cjs}` + `smoke.mjs` | **no** |
| `tools/` | the runner, the packaging gate, the host assert, the release driver, the skill-hash generator, dev/probe drivers | **no** |
| `scripts/` | the three runtime cycle scripts only — `journal-compress.mjs`, `madoromi-solo.mjs`, `persona-reflux.mjs` | **yes**, and unpacked |

Until 0.3 P2 all of it lived in `scripts/`, which `build.files` shipped whole
and `asarUnpack` made executable on disk — 85 test programs and every dev tool
in every installer. `tools/test-packaging.mjs`'s PAYLOAD gate now fails the
build if anything under `tests/`, `tools/` or `docs/` finds its way back in,
and fails it the other way too if a file in `scripts/` is not named in
`build.files`. If you add a script, that gate makes you say which kind it is.

## Tests

- Full regression before merging to trunk: **`npm test`**
  (`tools/run-tests.mjs`: every `tests/test-*.{mjs,cjs}` plus `tests/smoke.mjs`
  and `tools/test-packaging.mjs`, one process each, per-file timeout, exit
  non-zero if anything failed). Flags: `--live`, `--filter <substr>`,
  `--list`, `--timeout <s>`; per-test logs land in `release/test-logs/`
  (gitignored). Run one file directly with
  `node tests/test-<name>.mjs`. The old line here -- `node scripts/test-*.mjs`
  -- ran ONE file and passed the other 84 paths to it as argv.
- `npm test -- --live` adds the three lanes that need this machine's real
  state: `test-calendar` (the real Calendar, TCC), `test-attach-topology`
  (a real tmux binary + server), and `test-packaging`'s artifact lane (a
  freshly built dmg/exe). Without `--live` they print the skip marker.
  `test-packaging` still runs fail-closed as `npm run dist`'s
  predist/postdist hook -- that is the ship gate, and it stays hard.
  `predist` also runs `tools/assert-platform.mjs <target>` FIRST, so a
  `npm run dist:win` on a Mac refuses before it spends four minutes running
  the mac-lane packaging test.
- SKIP is never a pass. A program that cannot run on this host prints
  `SKIP: <reason>` at COLUMN 0 and exits 0; a SECTION that could not be set
  up prints an INDENTED `  SKIP ...` and the file keeps running. The runner
  counts both and lists them under the summary. If you add a skip, say what
  is missing and why the assertions could not hold here.
- Anything touching agent lifecycle, tmux, or spawn paths must keep
  `tests/test-attach-topology.mjs` green. The one-line invariant it
  protects: **the app must NEVER cause a tmux server to exist**
  (docs/design-0016-attach-topology.md §Invariant — read that doc first,
  it is the architecture's heart).

## PR flow

- Solo runs on a feature branch: push freely, no ceremony.
- **Merging to `master` goes through a PR** once there is more than one
  committer (i.e., now). Review: PO (Idea) or Mino; author merges after
  review + green tests.
- Releases: `docs/RELEASE.md`, driven by `node tools/release-all.mjs`.
- Small docs/chore changes: PR still, review may be a one-line ack.
- No force-push to `master`. Force-push to your own feature branch is
  your business.

## Landmines (read before first change)

- **Harness-rendered files**: everything under `onboarding/templates/`
  is re-rendered into DATA_HOME on every app boot. Edit the template,
  never the rendered copy — rendered edits are silently overwritten.
- **Permission-sensitive features (screen capture, automation, disk
  access) live in the AGENT lane** — tools running inside the tmux pane,
  never in the Electron app. An app-side capture call re-keys the TCC
  grant to the per-release ad-hoc signature, resurrecting the exact
  breaks-every-update class design-0016 kills. (Mino Q&A 2026-07-23)
- `main.cjs` spawn/stop paths are lifecycle-serialized on purpose; read
  the comments around `spawnRealAgentChildLocked` before touching.
- Design docs: `docs/design-NNNN-<slug>.md`, numbered, append-only
  (amendments go in dated sections, history stays).

## Agent capability sync

Add a feature that changes how the AGENT behaves at runtime (it uses it or
must know it — sudo, a new tool, topology, channel/provider, restart)? You
MUST also sync it into the agent's two instruction surfaces:
`onboarding/templates/agent-system-prompt.md` (short, behavior-defining)
and `CLAUDE.md` (usage detail). A capability the agent was never told about
is how it misfires — 2026-07-23: sudo shipped with no agent-facing docs,
the agent tried `sudo -n`, failed, and proposed a NOPASSWD self-escalation.

Scope: agent BEHAVIOR only. Pure UI, onboarding flow, and build config
don't belong in the prompt. MCP tools self-document via their own schema,
and in-situ hooks self-explain when they fire — those earn a prompt line
only if proactive awareness matters, not by default.

## Language

- Code comments + docs: English. User-facing strings (UI, CLI output):
  Korean. Korean quotes inside English docs are normal here.
