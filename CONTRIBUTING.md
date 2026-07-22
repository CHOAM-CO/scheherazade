# Contributing — Scheherazade

Working agreement for this repo. Short on purpose; the repo's real
conventions live in its history — when in doubt, `git log` a similar change.

> Status: DRAFT (2026-07-22, Idea). PR-flow section awaits input from
> 은호 + Mino. File a PR against this file to change the rules themselves.

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

## Tests

- Full regression before merging to master: `node scripts/test-*.mjs`
  (each file is standalone; all green = mergeable).
- Anything touching agent lifecycle, tmux, or spawn paths must keep
  `scripts/test-attach-topology.mjs` green. The one-line invariant it
  protects: **the app must NEVER cause a tmux server to exist**
  (docs/design-0016-attach-topology.md §Invariant — read that doc first,
  it is the architecture's heart).

## PR flow (PROPOSAL — settle with 은호/Mino, then delete this label)

- Solo runs on a feature branch: push freely, no ceremony.
- **Merging to `master` goes through a PR** once there is more than one
  committer (i.e., now). Review: PO (Idea) or Mino; author merges after
  review + green tests.
- Small docs/chore changes: PR still, review may be a one-line ack.
- No force-push to `master`. Force-push to your own feature branch is
  your business.

## Landmines (read before first change)

- **Harness-rendered files**: everything under `onboarding/templates/`
  is re-rendered into DATA_HOME on every app boot. Edit the template,
  never the rendered copy — rendered edits are silently overwritten.
- `main.cjs` spawn/stop paths are lifecycle-serialized on purpose; read
  the comments around `spawnRealAgentChildLocked` before touching.
- Design docs: `docs/design-NNNN-<slug>.md`, numbered, append-only
  (amendments go in dated sections, history stays).

## Language

- Code comments + docs: English. User-facing strings (UI, CLI output):
  Korean. Korean quotes inside English docs are normal here.
