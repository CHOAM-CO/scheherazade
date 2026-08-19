// dsh-client.cjs — minimal client for the dsh web gateway (0.2.1 junction).
//
// Speaks the rc-7 wire contract mapped in docs/design-0021-dsh-junction.md:
//   POST /api/<method>  {type:'client-request', rpcId, method, payload}
//   WS   /api/events.mux  (downlink-only session/event stream)
//   WS   /api/events.host (session add/remove, running flips)
//
// Isomorphic on purpose: uses global fetch + WebSocket, so the same module
// serves the Electron renderer (chat/trajectory pane) and node-side bridges
// (channel junction). Node >= 22 and Electron both ship the globals.
//
// RC-BUMP WATCH: method names live in dsh-host-apiproxy rpc-map.d.ts and
// may move (legacy ApiProxy -> Typert migration). Event vocabulary is the
// stabler plane. Re-check both on any dsh version change — the pin is
// exact (0.1.0-rc.7) precisely so this file cannot rot silently.

'use strict'

let seq = 0
function rpcId () {
  seq += 1
  return `schz-${Date.now().toString(36)}-${seq}`
}

class DshClient {
  /** @param {string} baseUrl e.g. "http://127.0.0.1:57676" */
  constructor (baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
  }

  async call (method, payload = {}) {
    const body = { type: 'client-request', rpcId: rpcId(), method, payload }
    const res = await fetch(`${this.baseUrl}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!res.ok) throw new Error(`dsh ${method}: HTTP ${res.status}`)
    const frame = await res.json()
    // Measured rc-7 shape (2026-08-19 live): {type:'server-response', rpcId,
    // result:{ok:boolean, value|error}}. Unwrap; refuse non-ok results.
    const r = frame && frame.result
    if (r && r.ok === false) throw new Error(`dsh ${method}: ${JSON.stringify(r.error ?? r).slice(0, 300)}`)
    if (r && r.ok === true) return r.value
    if (frame && frame.error) throw new Error(`dsh ${method}: ${JSON.stringify(frame.error).slice(0, 300)}`)
    return frame && (frame.payload !== undefined ? frame.payload : frame)
  }

  // ── sessions ────────────────────────────────────────────────────────────
  createSession (opts = {}) { return this.call('session.create', opts) }
  /** content: [{type:'text',text}] or image parts; mode 'queue' (default) | 'steer' */
  prompt (sessionId, content, opts = {}) {
    return this.call('session.prompt', { sessionId, mode: opts.mode || 'queue', content, clientTimeZone: opts.clientTimeZone || Intl.DateTimeFormat().resolvedOptions().timeZone })
  }
  cancel (sessionId) { return this.call('session.cancel', { sessionId }) }
  listSessions (opts = {}) { return this.call('session.list', opts) }
  history (sessionId, opts = {}) { return this.call('session.history', { sessionId, ...opts }) }
  models (opts = {}) { return this.call('session.models', opts) }
  selectModel (sessionId, provider, model, reasoningEffort) {
    return this.call('session.selectModel', { sessionId, provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) })
  }
  listWorkspaces () { return this.call('workspace.list', {}) }

  /** Answer an approval/question frame: echo its rpcId with the chosen payload. */
  async respond (frameRpcId, payload) {
    const res = await fetch(`${this.baseUrl}/api/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId: frameRpcId, payload })
    })
    if (!res.ok) throw new Error(`dsh respond: HTTP ${res.status}`)
    return res.json().catch(() => null)
  }

  // ── event streams ───────────────────────────────────────────────────────
  /**
   * Subscribe to the all-session mux. handlers: {onEvent(sessionId, event,
   * view), onControl(frame), onClose(err?)}. Returns {close()}.
   * No since-resume in rc-7: callers refetch history() after reconnect.
   */
  openMux (handlers = {}) {
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/api/events.mux`)
    ws.onmessage = (m) => {
      let frame
      try { frame = JSON.parse(m.data) } catch { return }
      // Measured rc-7 wire (2026-08-19): mux frames arrive as
      // {type:'server-request', rpcId, method, payload} where payload is the
      // actual {type:'session/event', sessionId, event, view?} frame.
      const inner = frame.type === 'server-request' ? frame.payload : frame
      if (!inner) return
      if (inner.type === 'session/event') {
        handlers.onEvent && handlers.onEvent(inner.sessionId, inner.event, inner.view)
      } else {
        handlers.onControl && handlers.onControl(inner)
      }
    }
    ws.onclose = () => handlers.onClose && handlers.onClose()
    ws.onerror = (e) => handlers.onClose && handlers.onClose(e)
    return { close: () => ws.close(), socket: ws }
  }

  openHostEvents (onFrame) {
    const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/api/events.host`)
    ws.onmessage = (m) => { try { onFrame(JSON.parse(m.data)) } catch {} }
    return { close: () => ws.close(), socket: ws }
  }
}

/**
 * Collect one completed reply from a session: send content, resolve with
 * {text, reasoning, toolCalls, usage} at turn/end. Bridge-side convenience
 * (channels); the chat pane consumes the stream directly instead.
 */
async function promptAndCollect (client, sessionId, content, { timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const acc = { text: '', reasoning: '', toolCalls: [], usage: null }
    const mux = client.openMux({
      onEvent (sid, event) {
        if (sid !== sessionId || !event) return
        if (event.type === 'assistant/chunk') {
          const c = event.data && event.data.chunk
          if (!c) return
          if (c.type === 'text-delta') acc.text += c.text || c.delta || ''
          else if (c.type === 'reasoning-delta') acc.reasoning += c.text || c.delta || ''
          else if (c.type === 'usage') acc.usage = c
        } else if (event.type === 'tool/call') {
          acc.toolCalls.push(event.data)
        } else if (event.type === 'turn/end') {
          clearTimeout(timer); mux.close(); resolve(acc)
        }
      },
      onClose (err) { clearTimeout(timer); if (err) reject(err) }
    })
    const timer = setTimeout(() => { mux.close(); reject(new Error('dsh turn timeout')) }, timeoutMs)
    // Open the stream BEFORE prompting so no early chunks are lost.
    client.prompt(sessionId, content).catch((e) => { clearTimeout(timer); mux.close(); reject(e) })
  })
}

module.exports = { DshClient, promptAndCollect }
