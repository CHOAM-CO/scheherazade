// notify-agent-reply.cjs — OS notification when the agent replies while the
// window is not being looked at (v0.1.11, pattern noted from Orca ADE's
// finish-notifications — internal research notes 2026-08-14).
//
// The user's real usage shape is "ask, then go do something else": a long
// agent turn ends in a reply that sits unseen in a background window. The
// chat page cannot carry this (a backgrounded/hidden renderer is exactly the
// case we care about), so the MAIN process watches the durable transcript —
// DATA_HOME/chat-transcript.json, rewritten by channel-local.mjs's
// flushTranscript() after every queue push — and raises a native
// Notification for new role:'agent' kind:'message' items.
//
// Why watch the transcript file instead of teeing into the chat proxy or the
// channel: the file is the one surface that ALL reply paths already share
// (the reply tool awaits its durable write before claiming "sent"), it needs
// zero protocol changes, and a watcher can never break the chat itself.
// fs.watchFile (stat polling), not fs.watch: the writer replaces the file by
// tmp+rename, and inotify/FSEvents watchers follow the inode — they go
// silent after the first swap. 1.5s polling on one small file is nothing.
//
// Notify policy:
//   - cursor starts at the CURRENT max seq — restored history never notifies
//   - only items newer than the cursor, kind 'message' + role 'agent'
//     (activity presence lines are not even persisted; reactions stay quiet)
//   - suppressed while any app window is focused — the user is already
//     looking at it. No window at all (closed, minimized, other desktop)
//     notifies.
//   - one notification per flush batch (body = last reply, first line,
//     truncated) — a multi-reply turn must not machine-gun the notification
//     center
//   - click focuses/restores the window (same shape as second-instance)
//
// Contract, same as updater.cjs: init NEVER throws, and no failure in here
// may cost the user the chat — every fs/parse path fails soft to "no
// notification this tick".

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const POLL_MS = 1500
const BODY_MAX = 140

function firstLine(text) {
  const line = String(text).split('\n').find((l) => l.trim() !== '') || ''
  return line.length > BODY_MAX ? `${line.slice(0, BODY_MAX - 1)}…` : line
}

function initReplyNotifications({ app, Notification, BrowserWindow, DATA_HOME, log }) {
  try {
    if (!Notification || !Notification.isSupported()) {
      log('reply-notify: Notification unsupported on this platform; disabled')
      return
    }
    // Windows toasts are dropped unless the process's AppUserModelID matches
    // the installed shortcut's (NSIS writes it from build.appId). No-op
    // elsewhere.
    if (process.platform === 'win32') app.setAppUserModelId('com.choam.scheherazade')

    const file = path.join(DATA_HOME, 'chat-transcript.json')

    const readAgentSeqs = () => {
      // {maxSeq, items} of agent messages; null when unreadable (absent,
      // mid-write in a non-atomic filesystem, corrupt) — callers keep the
      // previous cursor and try again next tick.
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        const queue = Array.isArray(raw && raw.queue) ? raw.queue : []
        const items = queue.filter((m) => m && m.kind === 'message' && m.role === 'agent' && Number.isFinite(m.seq))
        const maxSeq = Math.max(Number(raw.seq) || 0, ...queue.map((m) => Number(m.seq) || 0), 0)
        return { maxSeq, items }
      } catch {
        return null
      }
    }

    // Seed the cursor from what is already on disk so a boot never replays
    // yesterday's conversation into the notification center.
    let cursor = (() => {
      const now = readAgentSeqs()
      return now ? now.maxSeq : 0
    })()

    const onTick = () => {
      try {
        const now = readAgentSeqs()
        if (!now) return
        const fresh = now.items.filter((m) => m.seq > cursor)
        // The cursor advances past EVERYTHING seen this tick (user messages
        // included) even when we do not notify: a focused-window reply must
        // not fire retroactively the next time an unrelated item lands.
        cursor = Math.max(cursor, now.maxSeq)
        if (fresh.length === 0) return
        const focused = BrowserWindow.getAllWindows().some((w) => {
          try { return w.isFocused() } catch { return false }
        })
        if (focused) return
        const last = fresh[fresh.length - 1]
        const n = new Notification({
          title: fresh.length > 1 ? `Scheherazade (${fresh.length})` : 'Scheherazade',
          body: firstLine(last.text),
          silent: false,
        })
        n.on('click', () => {
          try {
            const win = BrowserWindow.getAllWindows()[0]
            if (!win) return
            if (win.isMinimized()) win.restore()
            win.show()
            win.focus()
          } catch { /* focusing is best-effort */ }
        })
        n.show()
      } catch (err) {
        // Never rethrow into the timer; one bad tick must not kill the watcher.
        log(`reply-notify: tick failed (continuing): ${err.message}`)
      }
    }

    fs.watchFile(file, { interval: POLL_MS }, onTick)
    app.on('will-quit', () => { try { fs.unwatchFile(file) } catch { /* teardown */ } })
    log('reply-notify: watching chat transcript for background replies')
  } catch (err) {
    try { log(`reply-notify: init failed (feature off, app unaffected): ${err.message}`) } catch { /* logging is best-effort too */ }
  }
}

module.exports = { initReplyNotifications }
