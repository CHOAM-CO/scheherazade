;(function(root) {
  // Preserve raw offsets so streamed fences can be skipped without losing state.
  function split(text, flush = false) {
    const sentences = []; let start = 0, i = 0
    const emit = end => { const s = text.slice(start, end).trim(); if (s) sentences.push(s); start = end }
    while (i < text.length) {
      if (text.startsWith('```', i)) {
        emit(i)
        const close = text.indexOf('```', i + 3)
        if (close < 0) { if (flush) start = text.length; break }
        i = close + 3; start = i; continue
      }
      const ch = text[i]
      if ('。!?…\n.'.includes(ch)) {
        let end = i + 1
        while (end < text.length && '。.!?…\n'.includes(text[end])) end++
        if (ch === '.') {
          if (end === text.length && !flush) break
          if (end < text.length && !/\s/.test(text[end])) { i = end; continue }
          // Common abbreviations and initials remain attached to the sentence.
          if (end === i + 1 && /(?:\b(?:Mr|Mrs|Dr|Ms|Prof|etc|e\.g|i\.e)|\b[A-Z])$/i.test(text.slice(start, i))) { i = end; continue }
        }
        emit(end); i = end; continue
      }
      i++
    }
    let rest = text.slice(start)
    if (flush) { if (rest.trim() && !rest.includes('```')) sentences.push(rest.trim()); rest = '' }
    return { sentences, rest }
  }
  const normalized = text => text.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()
  function createReplySpeech(enqueue) {
    let raw = '', consumed = 0, abandoned = false
    return {
      prime(text) { raw = text || ''; consumed = raw.length; abandoned = false },
      reset() { raw = ''; consumed = 0; abandoned = false },
      abandon() { if (raw) abandoned = true },
      update(text, final = false) {
        if (!abandoned) {
          let offset = consumed
          if (!text.startsWith(raw.slice(0, consumed))) {
            // Match the normalized spoken prefix in the final; never restart at 0.
            const prefix = normalized(raw.slice(0, consumed))
            let matched = -1
            for (let i = 0; i <= text.length; i++) if (normalized(text.slice(0, i)) === prefix) { matched = i; break }
            if (matched >= 0) offset = matched
            else { let common = 0; while (common < raw.length && common < text.length && raw[common] === text[common]) common++; offset = Math.min(text.length, Math.max(consumed, common)) }
          }
          const part = split(text.slice(offset), final)
          for (const s of part.sentences) enqueue(s)
          consumed = text.length - part.rest.length
        }
        raw = text
        if (final) { raw = ''; consumed = 0; abandoned = false }
      },
    }
  }
  function micHealth(active, mode) { return !active ? 'off' : mode === 'listening' ? 'ok' : mode === 'processing' ? 'opening' : 'failed' }
  function playbackExpired(audio, started, now) {
    if (audio._stalledAt != null) return now - audio._stalledAt >= 8000
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1500 + 5000 : 120000
    return audio.ended || (audio.paused && now - started > 500) || now - started > Math.min(120000, duration)
  }
  function suppressMic(running, audible, lastEnd, now) { return running || audible || (lastEnd > 0 && now - lastEnd < 300) }
  // A failed segment gets one retry; only three exhausted segments end a call.
  function createSegmentRetry({ onLimit, wait = () => new Promise(resolve => setTimeout(resolve, 250)) }) {
    let failures = 0, epoch = 0
    return {
      reset() { failures = 0; epoch++ },
      async run(request, valid = () => true) {
        const e = epoch
        for (let attempt = 0; attempt < 2; attempt++) {
          if (e !== epoch || !valid()) throw new Error('Call segment cancelled')
          try {
            const result = await request()
            if (e !== epoch || !valid()) throw new Error('Call segment cancelled')
            failures = 0
            return result
          } catch (error) {
            if (e !== epoch || !valid()) throw error
            if (attempt === 0) { await wait(); continue }
            if (++failures >= 3) onLimit(error)
            throw error
          }
        }
      },
    }
  }
  function createSession({ send, closeMic, clearQueue, now = () => Date.now() }) {
    let on = false, generation = 0
    const recent = new Map()
    return {
      get on() { return on }, get generation() { return generation },
      start() { on = true; recent.clear(); return ++generation },
      partial(text, stopSpeech) { if (on && text.trim()) stopSpeech() },
      final(text, g = generation) {
        text = text.trim()
        if (!on || g !== generation || !text) return
        const time = now(), key = text.normalize('NFC').replace(/\s+/g, ' ').toLowerCase()
        for (const [value, at] of recent) if (time - at >= 2000) recent.delete(value)
        if (recent.has(key)) return
        recent.set(key, time); send(text)
      },
      stop() { on = false; generation++; closeMic(); clearQueue() },
    }
  }
  const api = { split, createSegmentRetry, createSession, createReplySpeech, micHealth, playbackExpired, suppressMic }
  if (typeof module !== 'undefined') module.exports = api
  else root.SeraCallCore = api
})(typeof window !== 'undefined' ? window : globalThis)
