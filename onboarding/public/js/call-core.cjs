;(function(root) {
  function split(text, flush = false) {
    const sentences = []; let start = 0
    for (const m of text.matchAll(/[。.!?…\n]+/g)) {
      const end = m.index + m[0].length
      const s = text.slice(start, end).trim(); if (s) sentences.push(s)
      start = end
    }
    let rest = text.slice(start)
    if (flush) { if (rest.trim()) sentences.push(rest.trim()); rest = '' }
    return { sentences, rest }
  }
  function createSession({ send, closeMic, clearQueue }) {
    let on = false, generation = 0
    return {
      get on() { return on }, get generation() { return generation },
      start() { on = true; return ++generation },
      partial(text, stopSpeech) { if (on && text.trim()) stopSpeech() },
      final(text, g = generation) { if (on && g === generation && text.trim()) send(text.trim()) },
      stop() { on = false; generation++; closeMic(); clearQueue() },
    }
  }
  const api = { split, createSession }
  if (typeof module !== 'undefined') module.exports = api
  else root.SeraCallCore = api
})(typeof window !== 'undefined' ? window : globalThis)
