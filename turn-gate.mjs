// turn-gate.mjs -- cross-channel turn ownership for the headless lane (0.3.7).
//
// The lane runs ONE claude session with ONE stdin. Inbound messages written
// mid-turn MERGE into the live turn (probe 6, headless-lane.mjs result
// handler): fine for one conversation, wrong for two -- a Slack message that
// merges into a Discord turn is answered inside that turn, and the model
// routes its reply by whichever channelId it happens to pick. So with more
// than one messenger enabled, a turn is OWNED by the surface (messenger) that
// opened it:
//   - idle lane              -> the message opens a turn and owns it
//   - same surface, mid-turn -> merges exactly as before (steering unchanged)
//   - other surface, mid-turn-> QUEUED; the lane acks it (200, queued:true) and
//                               delivers it when the owning turn's result lands
// On turn end the oldest queued item opens the next turn, together with every
// queued item from the same surface (they were one conversation). Single-
// messenger installs never enable the gate: behaviour is byte-identical.
//
// Pure state machine, no IO: the lane owns delivery, persistence (queued items
// sit in the pending FIFO with queued:true so a recycle redelivers them) and
// the clock.

export function createTurnGate({ enabled = false } = {}) {
  let owner = null
  const queue = []
  return {
    get owner() { return owner },
    get size() { return queue.length },
    // -> 'deliver' | 'queue'. turnOpen = the lane has an unpaid user event in flight.
    admit(surface, turnOpen) {
      const s = String(surface || '')
      if (!enabled || !s) return 'deliver'
      if (!turnOpen || owner === null) { owner = s; return 'deliver' }
      return owner === s ? 'deliver' : 'queue'
    },
    enqueue(item) { queue.push(item) },
    // Call when a turn ended and the lane is idle. -> items to deliver now (may be []).
    release() {
      owner = null
      if (!queue.length) return []
      const first = queue[0].surface
      const out = []
      for (let i = 0; i < queue.length;) {
        if (queue[i].surface === first) out.push(...queue.splice(i, 1)); else i++
      }
      owner = first
      return out
    },
    snapshot() { return { owner, queued: queue.map((q) => q.surface) } },
  }
}
