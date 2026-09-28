# design-0024 — the pending signal ("!") in the chat header

Drafted 2026-09-28 from the owner's own description, in two passes the same
evening. Status: **design only, nothing built.** The avatar work (separate)
is what he approved for release; this is the next piece.

His words, in order:

> 채팅창에 세헤라자드 이름만 뜨는데 프로필 사진 뜨고 이야기하면 좋을 것 같아
> 페르소나나 시스템 프롬프트 / 교정 파일같은거 쌓여있으면 채팅창 위에서 퀘스트처럼
> ! 떠있고 누르면 바로 세라가 반응해서 고칠 수 있도록

then, correcting my first reading of it:

> ㄴㄴ 세라가 먼저 말을 거는 트리거고 유저도 채팅하면서 필요한거 하고 아닌거 안하는걸로
> 밀린 거 -> 페르소나 / 환류 / 꿈 등등 유저한테 얘기 안한거나 메모리 미비한부분 체크하도록

and the consent ruling:

> 자율모드에서만 ㅇㅇ, 비자율모드에서는 뭐 하지 말고

So it is **not a task queue and not an editor**. The user clicks a mark above
the chat; the app works out what has piled up, hands that to the agent once,
and the agent opens the conversation in her own voice, saying what is there
and what she would change. Acting on any of it stays the existing per-item
flow (his click). Skipping the rest is a legitimate outcome, not a dismissal
that has to be recorded.

## What already exists (verified 2026-09-28, not assumed)

Three of his four sources are already accumulators. None of them is
user-facing today, which is the whole gap.

| source | where it piles up | who sees it now |
|---|---|---|
| corrections | `corrections` table, `still_active` flag (`memory/service.mjs:93-152`) | the agent, twice: every reply (`hooks/pre-reply-corrections-context.mjs`) and at boot (`hooks/session-start-reflux-card.mjs`, threshold + snooze in `.gates/reflux-card.json`) |
| reflux | `.review/reflux-proposals.md`, deduped by `.review/.reflux-seen` (`scripts/persona-reflux.mjs`) | the agent, when something runs the script. **No shipped schedule** — `README.md:124-128` documents a crontab line for the user to add |
| dreams | `dreams/YYYY-MM-DD.md` (`scripts/madoromi-solo.mjs`, `procedures/madoromi.md`) | the agent, at boot (`hooks/session-start.mjs`) |
| "유저한테 안 한 것 / 메모리 미비" | nothing | nobody. No told/untold flag anywhere |

Two facts that change the shape of this feature:

- **The madoromi and memory-consolidation defaults are `createdBy:'agent'`**
  (`cadence/schedule-tick.cjs:284-293`), and agent-authored entries are
  skipped unless `AUTONOMY=yes` (`:225-226`). With autonomy off, dreams never
  form and this signal has nothing to say about them. That matches his ruling:
  dreams count under autonomy only, and non-autonomy gains no new machinery.
- **`.review/reflux-proposals.md` is not fed by anything automatic in the
  app.** If the design counts proposals, the count will sit still until the
  agent runs the pass. Do not build a schedule for it as part of this — that
  is a separate consent question (it costs tokens) and he has not asked.

## The seam that carries it (already used in this codebase)

`channel-runtime.mjs`'s `createBootAnnouncer` injects a turn into the running
agent with

```js
notify({ content: '[SYSTEM] …', meta: { sender: 'SYSTEM', channelId, authorId: '', timestamp } })
```

which is `mcp.notification({ method: 'notifications/claude/channel' })`. The
boot greeting rides it, and it deliberately omits "답장하지 마" so
`stop-reply-guard` *enforces* that the greeting lands. This feature is the
same shape with a different payload, which is why it is cheap: no new
transport, no new delivery rail.

## What has to be built

1. **The click-time reader.** A route (`GET /api/pending-signal`) that
   computes the list on the spot from file/DB state. No periodic job, per his
   ruling, and no scheduled work in non-autonomy mode. Dream fragments enter
   the list only when they exist, which is only under autonomy.
2. **The stamp.** "밀렸다" needs a "last told" mark per source, or the same
   pile is announced at every click. The precedents are `.last-briefed-version`
   (update brief), `.reflux-seen` (reflux dedup) and `.gates/reflux-card.json`
   (the boot card's snooze, which already re-arms only when the count rises).
   One file in the same `.gates/` directory holding, per source, whatever
   digest was true when she last recited it. The digest is compared, never
   interpreted: no new judgment lives in the stamp.
3. **The inject.** `POST /api/pending-signal/recite` → build the list → one
   `[SYSTEM]` turn telling her what is waiting and that she should open the
   conversation about it. Same no-"답장하지 마" shape as the boot greeting so
   the guard makes the utterance land. If the list is empty the route answers
   so and injects nothing.
4. **The mark.** The "!" above the chat: hidden when the list is empty, lit
   when it is not. It is a read of the same route, not a second calculation.
5. **The one genuinely new detector** — "유저한테 안 한 것 / 메모리 미비".
   Nothing in the app measures it. `open_threads.status` carries `stale` in
   its enum and no code writes it; `salience` claims to decay and nothing
   decays it. Two honest options, smallest first:
   - **(a) no new data**: define the pile as "what she wrote that you have not
     been shown" — the corrections count, the pending proposals, the dream
     fragments — and let *her* name the memory gaps in the recital, in chat,
     from what she already knows. No schema, no pass, no cost when nobody
     clicks.
   - **(b) a real measure**: a click-time pass over recent journal/threads
     that names open threads as gaps. Costs a model call per click and needs
     a definition of "gap" that survives a second opinion. Do not start here
     unless (a) proves too vague in practice.

## What this must not do

- No editing surface, no task list, no "dismissed" bookkeeping per item. He
  asked for a trigger that makes her speak, not a queue the user works.
- No new scheduled work. The only thing that runs is what the click starts.
- Nothing that turns autonomy on, or that requires it for the parts that do
  not need it (the click itself, the corrections count, the proposals).
- No automatic write to `self_persona.md`. The pack's rule stands: it changes
  only through the reflux cycle with his approval per item.

## Tests worth having

- The route with an empty pile answers empty and injects nothing (the common
  case on a fresh install must not produce a phantom "!").
- The stamp is written after a recital and the same pile is *not* announced
  twice; a source that grows re-lights it.
- Inject-shape pin: the recital turn carries no "답장하지 마", the boot
  greeting's own test is the precedent.
- The reader never throws on a missing `.review/`, a missing `dreams/`, or an
  unreadable DB — an advisory surface must fail toward silence, the same
  posture as `session-start-reflux-card.mjs`.
- Nothing in the pending computation runs when nothing is clicked: a pin that
  the route is not registered anywhere as a schedule.

## Open, for the owner

- Does the mark ever nag? The boot card re-arms on change; this could be
  strictly user-pulled (it only ever appears, never speaks first on its own).
- (a) or (b) for the memory gap. My read: start at (a).
- Whether the mark should also exist outside the chat page.
