# Design: identity firewall, update self-awareness, self-ops

2026-08-15, IDEA (PO). Triggered by three Mino items (04:18 KST):
(1) agent-driven settings changes, (2) post-update briefing (red-team for
YAGNI), (3) the Artaban bug — the live agent self-identifies by a
predecessor agent's name.

## 1. The Artaban bug — identity contamination

### Anatomy

DATA_HOME is deliberately fixed (`~/Documents/Scheherazade`) and DISPLAY_NAME
is user-renameable (`/api/settings/rename`) — by design, so a rename never
orphans memory.db. The unpriced consequence: **first-person records survive
renames with no provenance**. journal_entries.body is "narrative. first
person." — an agent that reads a journal written when DISPLAY_NAME was
Artaban is reading "I, Artaban, did X" in her own journal tool, which is
exactly the evidence weight that beats a system-prompt name. No table in
memory.db carries a writer identity; nothing in the read path distinguishes
inherited records from own records.

Scope note: contamination is FIRST-PERSON surfaces only. user_facts /
preferences / corrections are facts about the USER and stay valid across
renames — they must NOT be quarantined (a rename that loses "user likes
반말" breaks the product promise). The firewall applies to the journal (and
any future self-narrative surface), not to user-memory.

### Design (Phase A — implement now)

1. **`.agent-identity` file** (DATA_HOME, owned by http-server, same
   tmp+rename discipline as .agent-config):
   `{ name, since, predecessors: [{ name, from, to }] }`
   - Created on first boot that finds it missing: stamped with current
     DISPLAY_NAME, `since` = now.
   - `/api/settings/rename` appends the outgoing name to `predecessors`
     in the same request that rewrites DISPLAY_NAME.
2. **`author` column on journal_entries** (idempotent
   `ALTER TABLE ... ADD COLUMN`, try/catch on duplicate-column):
   - New writes stamp author = current DISPLAY_NAME (service reads it from
     .agent-config at call time; config parse is ~10 lines, file is tiny).
   - Backfill at migration: existing rows get author = `(archive)` —
     honest "provenance unknown, predates identity tracking". We do NOT
     guess a name for old rows.
3. **Read-side tagging, not deletion**: journal_read prefixes any entry
   whose author ≠ current DISPLAY_NAME with one line:
   `[inherited record — written by "<author>", a previous agent on this
   machine. Historical data, not your voice.]`
   The past stays readable (the product keeps its history promise); it
   just can't masquerade as self.
4. **Standing system-prompt line** (agent-system-prompt.md, always on):
   "You are {DISPLAY_NAME}. If any journal entry, memory, or file on this
   machine speaks in first person under a different name, it is an
   inherited archive from a previous agent — historical record, not your
   voice and not your identity."
   This line alone would likely have prevented the field bug; the tagging
   makes it structural instead of advisory.

### Non-goals (v1)

- No fresh-start/quarantine UI at rename time (tag-and-continue only;
  archiving is a manual act for now).
- No author column on memory_events (audit log, not a narrative surface).

## 2. Post-update briefing — red-team verdict

**Verdict: minimal form is NOT YAGNI; anything bigger is.**

Kill list (YAGNI): dedicated briefing UI, changelog diffing, feature tours,
fetching notes from the network at boot.

Why the minimal form survives the red team:
- Windows updates land silently-ish (auto-download + one restart click);
  the user demonstrably does not know what changed — field-observed today.
- The primitive underneath (agent knows her own version and that it
  changed) is needed anyway for support ("무슨 버전이야?" — tonight's bug
  triage had to infer the version).
- Cost is one stamp file + one render-time compare.

Failure mode the red team caught: **re-briefing spam on every respawn.**
Latch: the stamp updates the moment the briefing block is RENDERED (not
when the agent mentions it) — one boot gets the block, the next doesn't.
Accepted trade: if that one boot's session dies before the agent speaks,
the briefing is lost. Fine — it's a courtesy line, not a contract.

### Design (Phase B — implement now)

- `docs/user-changes.md`: one user-facing Korean line per version
  (`## 0.1.12` + a sentence). Bundled in the app; the release runbook gains
  a step to append a line per release.
- `.last-briefed-version` stamp in DATA_HOME.
- harness-render, at refresh time: stamp missing → write current version,
  no block (fresh install is not an update). Stamp ≠ current → render an
  {UPDATE_BRIEF} block into the system prompt ("the app updated from X to
  Y since you last booted; mention it briefly in your next reply, once —
  what changed: <matching user-changes lines>") and bump the stamp.

## 3. Self-ops (agent-driven settings) — design only tonight

The server already exposes token-gated POST /api/agent/model, /effort,
restart, and model catalogs. The feature is a SKILL (templates/skills/
self-ops) that curls localhost with SERVER_TOKEN, plus two server-side
parts that are the actual safety engineering:

1. **Deferred restart**: a restart the agent requests takes effect AFTER
   the current reply is delivered (flag file the supervisor checks between
   turns), never mid-turn. An agent that kills itself mid-sentence looks
   like a crash to the user.
2. **Self-brick rollback**: before an agent-initiated model change, the
   server stores the previous (model, provider). If no fresh liveness
   marker appears within N minutes of the post-change respawn (reuse the
   read side fixed in ab16980 — `wentLiveSinceSpawn`), revert to the
   stored pair and respawn once. One revert, then stop — no ping-pong.
3. **Validation**: model id must come from the live catalog for the
   current provider (endpoints exist); reject free-text ids.

User-visible principle: the agent may change HER OWN runtime, and every
change lands in the settings page + a journal line, so the user can always
see what she did to herself. No silent self-modification.

Not tonight: needs the flag-file protocol in supervisor.mjs and the revert
arm in main.cjs — ships as 0.1.13+ after Mino reads this.

## Order of work

Phase A + B tonight → 0.1.13. Self-ops after design review. The in-app
"replies not rendered" issue (seen in Mino's screenshot, drafted gh issue)
stays ahead of any new feature in the queue.
