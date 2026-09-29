# design-0022 — Onboarding v2: detect & import existing agent data
2026-08-04, idea. Trigger: Mino 19:47 "유저 온보딩이랑 클로드 코덱스
헤르메스 오픈코드 오픈클로에서 유저들 데이터 마이그레이션 유도 방향
생각해보자". Status: PROPOSAL — needs Mino's call before any code.

## 1. Why this is the highest-leverage onboarding move

research-0021's churn table: the #1 retention driver for this category is
"the agent knows me" (memory-that-feels-real), and the #1 adoption tax is
setup burden. Every target user ALREADY has an agent that knows them —
in ~/.claude, ~/.codex, ~/.hermes, opencode's config, an openclaw
workspace. Today that history is a switching COST (reason to stay put).
One import step turns it into a switching BRIDGE: first conversation
opens with the agent already knowing your name, your projects, your
preferences. That is the "recurring value from day 0" P1 wanted, without
waiting for templates to accumulate value.

## 2. Detection matrix (what exists on the user's disk)

Sources and import value. Credentials are NEVER touched — every tool's
auth file is skip-listed by name, not by judgment call.

| Source | Root | Import: HIGH value | Skip (never read) |
|---|---|---|---|
| Claude Code | `~/.claude`, `~/.claude.json` | `CLAUDE.md` (global + per-project), `projects/*/...jsonl` session transcripts, memory dir | `.credentials.json`, keychain |
| Codex CLI | `~/.codex` | `AGENTS.md`, `config.toml` (model prefs), `sessions/` rollouts | `auth.json` |
| Hermes | `~/.hermes` (bound from local inspection 2026-08-04) | `SOUL.md`, `memories/`, `sessions/`, `cron/` (recurring jobs!), `config.yaml` | `auth.json`, `.env`, `state.db` (opaque; sessions/memories cover it) |
| OpenCode | `~/.config/opencode` (+ sessions in `~/.local/share/opencode/opencode.db`) — VERIFIED opencode.ai/docs | `AGENTS.md`, `opencode.json`, `agents/`, `commands/` | `~/.local/share/opencode/auth.json` |
| OpenClaw | `~/.openclaw/workspace` — VERIFIED docs.openclaw.ai | `SOUL.md`, `AGENTS.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, `memory/`, `TOOLS.md`, `skills/` | `~/.openclaw/credentials/`, `agents/*/agent/*.sqlite` |

> All 5 rows verified 2026-08-04 (researcher pass w/ doc receipts +
> local ~/.hermes inspection). CORRECTION from the receipts:
> `~/.claude.json` moved to the skip list — it embeds MCP server tokens.
> Notable: OpenClaw ships `openclaw migrate` importing FROM
> claude/codex/hermes — its safety posture (preview-first, secrets
> redacted, credentials opt-in-only, no hook execution) is the reference
> we mirror. Codex v0.145 also ships `/import` from Claude Code/Cursor —
> this feature is now table stakes in the category; ours differs by
> being agent-performed (the takeover moment) instead of a file mapper.

## 3. What "import" means (mechanism)

**No schema mapping.** We do not translate Codex's format into ours —
that's a brittle N×M matrix. Instead:

1. **Copy, read-only, with receipt**: selected files → 
   `DATA_HOME/imported/<tool>/`, permissions 0600, byte-for-byte. The UI
   shows the exact file list BEFORE copying (path + size), user unchecks
   anything. Nothing leaves the machine — same local-only posture as
   everything else.
2. **Agent-side integration**: first boot after import gets one
   [SYSTEM] turn: "imported data from <tools> is in imported/ — read it,
   fold what matters into your own memory/checkpoint, then greet the
   user with what you learned." The LLM is the format adapter. This is
   the same trick the pressure-rotation handoff uses (0.0.55): the
   agent's own memory discipline does the migration.
3. **Session transcripts** are the bulky/risky part (可 contain secrets
   pasted long ago). v1: import OFF by default for transcripts, ON for
   instruction/memory/persona files. A later pass can offer "summarize
   my last month of Claude Code sessions" as an explicit agent task.
4. **Hermes cron jobs** are special: they map 1:1 onto our scheduled
   briefings (the calendar/11AM-briefing flow Mino already uses). Offer
   "re-create these schedules" as checkboxes.

### 3b. Mino's framing (20:13) — the agent DOES the sweep

"에이전트가 싹 다 긁어서 '제가 이제 챙길게요 그새끼는 죽이세요^^'".
This simplifies §3: the copy step shrinks to a CONSENT gate (per-tool
"훑어봐도 될까요?" toggle in onboarding), and the sweep itself is the
agent's first act — live in chat, narrated, using its own Read/Bash on
the detected roots (it already has the permissions). The payoff moment
IS the migration: the agent reports what it found and offers to take
over the old tool's recurring duties (Hermes crons → our briefings),
ending with the takeover line. Skip-lists (auth files) are enforced in
the [SYSTEM] prompt AND belt-and-suspenders in a pre-tool guard, not
left to model discretion.

## 4. UX — where it lives

- **Onboarding**: after provider connect succeeds, a new optional step:
  "이미 쓰던 에이전트를 찾았어요" — one card per DETECTED tool (absent
  tools never render; zero noise for clean machines), each with the file
  preview + import toggle. One click, done, skippable entirely.
- **Post-onboarding**: Settings > "Import from other agents" runs the
  same detection any time (covers users who onboarded before this
  ships, and tools installed later).
- **First-message payoff**: the greeting after import must PROVE it
  worked ("옮겨온 메모리 훑어봤어. ~하던 프로젝트 이어서 볼까?") — the
  demo moment that makes the migration feel real, not a silent copy.

## 5. 유도 (the funnel side)

- README + releases page: "3분이면 기존 에이전트(Claude Code / Codex /
  Hermes / OpenCode / OpenClaw)의 기억을 그대로 옮겨옵니다" — the
  migration is the headline feature FOR switchers, not a settings
  footnote.
- The detection step doubles as zero-cost market telemetry we do NOT
  collect: we deliberately keep it local-only (no pings home about what
  was detected) — consistent with the privacy posture, and P5's
  SECURITY.md gets to say so.

## 6. What shipped in v1 (0.0.57)

Mino 20:14 "동시에 가줘" → all 5 sources at once.

- `routes/migrate.cjs` (G12): GET /api/migrate/detect (bounded listing,
  forbidden names filtered + reported as skipped), POST
  /api/migrate/start (server-side re-detect, forged ids drop). Delivery
  is backend-independent: straight into the headless lane's ingest
  endpoint, or queued onto the boot-redelivery FIFO when the lane is
  down (no per-backend watcher needed — the discord-only [SYSTEM]
  watcher rail was NOT extended).
- Sweep [SYSTEM] turn: roots + highlights + DO-NOT-READ list +
  fold-into-memory + recurring-jobs inventory + the takeover reply
  (reply enforced by stop-reply-guard since the turn rides the home
  channel, same rail as the autonomy brief).
- `hooks/pre-tool-credential-guard.mjs` (layer 3, always-on): blocks
  Read/Glob/Grep/Bash touching any source tool's credential store or
  the keychain; path-shaped so a project-local `.env` stays readable.
- Settings > Import card (consent gate). Wizard step: NOT in v1 (below).
- test-migrate-routes.mjs, 27 pins.

Found while building (side receipts):
- 0.55's [SYSTEM]-prefix guard skip would have un-enforced the autonomy
  morning brief — fixed same day to match channelId === "system" only.
- channel-local/slack/telegram lack the shutdown/autonomy watcher rail
  entirely (discord-only): graceful-quit flush does not fire on those
  backends. Pre-existing gap, logged for a separate pass.

## 7. Remaining (v1.1) + open questions for Mino

v1.1: onboarding wizard step (reuses the same two endpoints; auto-skips
when nothing detected), README/releases funnel copy ("3분이면 기억
이사"), Hermes cron re-creation checkboxes, transcript-summarization as
an explicit agent task.

1. 세션 트랜스크립트: v1 스윕 프롬프트는 "시크릿 값은 옮겨적지 마라"
   지시로 커버. 더 조이려면(트랜스크립트 통째 제외) 말해줘.
2. 온보딩 위저드 스텝 추가 타이밍 — 지금 넣을까, 퍼널 카피랑 같이?

## 8. What shipped in v1.1 (0.3.5, Mino 2026-09-29 15:07 "다 해줘")

- `memory/migrate-import.cjs`: §3.1 copy-with-receipt. Per-source
  allowlist (only named paths are offered), byte-for-byte copy into
  `DATA_HOME/imported/<tool>/`, 0600, receipt JSON per run. Config files
  (settings.json, config.toml, opencode.json, config.yaml, openclaw.json)
  and credential stores are reported as "left in place", never read.
  Every selected file is scanned once in memory for key-shaped text and
  held back on a hit. Symlinks never followed. CLAUDE.md / AGENTS.md are
  stored as `imported-*.md` so the CLI never auto-loads them as the
  agent's own instructions. Sources are never moved, changed or deleted.
- Paths re-verified 2026-09-29 against current docs + local inspection:
  Claude `CLAUDE.md`, `rules/`, `agents/`, `commands/`,
  `projects/<p>/memory/*.md`, `projects/<p>/*.jsonl` (CLAUDE_CONFIG_DIR
  honored); Codex `AGENTS.md`, `AGENTS.override.md`, `prompts/`,
  `sessions/YYYY/MM/DD/rollout-*.jsonl` (CODEX_HOME); Hermes `SOUL.md`,
  `memories/MEMORY.md` + `USER.md`, `cron/jobs.json`, `sessions/`;
  OpenCode `AGENTS.md`, `agents/`, `commands/` (+ singular forms,
  XDG_CONFIG_HOME); OpenClaw workspace `AGENTS.md`, `SOUL.md`,
  `USER.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`, `memory/*.md`
  (OPENCLAW_PROFILE).
- Routes: GET `/api/migrate/import/plan`, POST `/api/migrate/import`
  (re-plans server side; forged or disallowed paths drop).
- Wizard step 1b, right after provider connect: one card per detected
  tool, per-file checkboxes (chat history OFF by default), Skip, Copy.
  Auto-skips when nothing is detected.
- Handover: the copy writes `imported/.handover-pending.json`;
  `hooks/session-start.mjs` turns it into a fold-into-memory line every
  session start until the agent deletes it. Live lane gets the same text
  as one [SYSTEM] turn. The pending FIFO is NOT used: headless-lane's boot
  redelivery drops sender=SYSTEM entries (see below).
- Found while building: the v1 `/api/migrate/start` "queued" path appends
  a sender=SYSTEM turn to `.headless-pending.json`, which the lane's boot
  redelivery filters out (headless-lane.mjs F4, 2026-08-05). Settings >
  Import tells the user "Queued" for a turn that never arrives. Not fixed
  in this pass.
- Still open: README/releases funnel copy, Hermes cron re-creation
  checkboxes, transcript summarization task, Codex `memories/` (layout not
  verifiable from docs). (Settings card: done in 0.3.6, custom folder and
  discover done in 0.3.7, see section 9.)

## 9. 0.3.6 and 0.3.7 follow-through

0.3.6:
- Settings > Import (the main card) moved to the copy flow: it drives the
  shared picker `onboarding/public/js/import-picker.js` off
  `/api/migrate/import/plan` and POSTs `/api/migrate/import`, same as the
  wizard. It no longer calls `/api/migrate/detect` or `/start`.
- Sweeps queued while the lane was down are flagged `sweep:true` and the
  lane delivers them at boot (`partitionPending` keeps them past the
  sender=SYSTEM drop). This fixes the "Queued but never delivered" bug noted
  in section 8. `GET /api/migrate/queue` lets Settings show Delivered.

0.3.7 (this pass):
- Settings > Hand it over now uses the copy flow too. Custom folder:
  `POST /api/migrate/custom/plan {root}` returns one card (markdown and text
  files only, three levels deep, config formats and credential names never
  offered); Copy POSTs `/api/migrate/import` with `customRoots`, which the
  server re-validates (home, filesystem root and the agent's own home
  refused) and re-plans. Discover: `GET /api/migrate/discover/plan` finds
  agent-shaped folders by marker filename (Spotlight on macOS, a
  depth-limited walk of the usual work folders elsewhere; known tool homes,
  the agent's own home and node_modules excluded) and each becomes a card.
  Copies land in `imported/custom-<name>-<hash>/`; the same content gate,
  receipt and handover marker apply. The legacy `/api/migrate/custom/*`
  sweep routes and `/detect` + `/start` still answer but no UI calls them.
- Boot race closed: headless-lane.mjs drains queued sweeps once more right
  after it publishes its ingest endpoint. An append made between the boot
  read and the endpoint is now delivered there; an append after it goes live
  through the endpoint. Pinned in tests/test-headless-lane.mjs (2c).
- Stop text is platform-aware: win32 says "Stopped. The conversation is
  kept." with no restart promise (no supervisor relaunch there); posix keeps
  the "back in a few seconds" line. Uses `IS_WIN` from the host-platform meta.
- Still open: README/releases funnel copy, Hermes cron re-creation,
  transcript summarization task, Codex `memories/`.
