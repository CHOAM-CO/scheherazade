# Handover — absorbing an arbitrary local agent (design 0023)

Mino 2026-08-05 19:38: "맥 다긁어서 persona.md / agents.md 같은 시스템프롬프트류
파일 긁어서 [전여친] 구조파악하고 메모리 시스템이나 동작구조 그대로 흡수 or
세헤라자드가 '해당 에이전트의 UI/UX화 or 참고할 수 있는 분화 에이전트'가 되게".
Observed gap: migrate (design-0022) handles claude/codex/hermes/opencode/openclaw
by fixed probes; a CUSTOM agent living anywhere (his 카덴스 on the Mac Studio)
is invisible to it, and Scheherazade "구조 파악은 잘 못하더라고".

## What ships in v1 (small delta on shipped machinery)

**A sixth migrate source: "custom path".** The user points at a directory —
"내 에이전트 여기 살아" — via a path input beside the five known-tool cards.

1. **Detect (server, names only).** Reuse the design-0022 walker on the given
   root: bounded listing (60 files / depth 3), FORBIDDEN_NAMES filter, sizes
   only, never contents. Add an agent-shape heuristic for the preview badge:
   any of `persona*.md`, `AGENTS.md`, `SOUL.md`, `CLAUDE.md`, `system_prompt*`,
   `*.persona`, `memories/`, `memory/`, `session*/`, `journal*/` present →
   "agent-shaped"; otherwise the preview says plainly "에이전트 흔적을 못
   찾았어요" and still shows the listing (user knows better than the
   heuristic).
2. **Consent preview.** Same surface as the five cards: file names + sizes +
   the DO-NOT-READ list. One click = one consented sweep turn.
3. **Sweep turn (the LLM is the format adapter — 0022 principle held).** The
   [SYSTEM] turn differs from known-tool sweeps: for a custom agent there is
   no known layout, so the prompt instructs STRUCTURE-FIRST:
   - Map the anatomy before absorbing: which file is the system prompt /
     persona, how memory is laid out (files? sqlite? dated notes?), what the
     boot/loop procedure is, what tools/channels it had.
   - Write the map to `DATA_HOME/handover/<name>.md` (English, evidence =
     file paths) BEFORE any absorption. This artifact is the "전여친
     구조파악" — it persists, so structure-questions later never re-cost a
     full sweep, and the user can read what their old agent actually was.
   - Then absorb per the user's live instruction in chat: memories into
     Scheherazade's own memory discipline, standing rules into CLAUDE.md's
     user-rules section — always as "learned from <name>", never silently
     overwriting its own persona.
4. **Safety = 0022's three layers unchanged**: forbidden names invisible in
   the listing, DO-NOT-READ list in the prompt, credential guard hook at the
   tool layer. A custom root ADDS one risk — the user can point at any
   directory (e.g. `~`) — so the route rejects roots that are a home dir or
   filesystem root outright ("좁혀서 지정해 주세요"), and the depth/count
   bounds already cap the blast radius.

## Explicitly NOT in v1 (v2 candidates, separate design)

- **분화 에이전트 / UI-UX-for-that-agent mode**: Scheherazade hosting a
  second persona (or fronting the other agent's live process) touches the
  single-agent architecture everywhere — harness render, hooks, channel
  identity, stop-reply guard. Needs its own design; do not bolt onto migrate.
- **Whole-disk autonomous scan** ("맥 다긁어서"): privacy blast radius and
  scan time both argue for point-me-at-it v1. If v1 shows the pointing step
  is the friction, a guided scan of likely roots (~/Documents, ~/Desktop,
  code dirs) can be v2 — still consent-gated per directory.

## Why structure-map-first is the fix for "구조 파악을 잘 못하더라고"

Today the sweep prompt says "absorb these files"; a weak model reads three
files and summarizes vibes. Forcing the persistent anatomy artifact first
(a) gives the absorption step a table of contents it can grep, (b) survives
session recycles mid-handover, (c) is checkable by the user — the same
receipts-not-code principle as the coding skill.
