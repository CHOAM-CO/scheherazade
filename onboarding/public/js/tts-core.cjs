'use strict'
// Speech text cleaner + playback queue, shared by renderer (<script> -> window.SeraTTSCore)
// and node tests (require). Pure, no DOM.
;(function (root) {
  const MAX_CHARS = 600

  // Product names the Korean Pocket-TTS model reads wrong in Latin (b f j q v w x y z are <unk>
  // in its tokenizer). Measured 2026-10-13, 3 seeds each: Hangul forms below hit, Latin 0/3.
  // Acronyms read letter by letter (GPT, API, OK, URL) stay Latin.
  const NAME_MAP = [
    [/\bClaude\b/gi, '클로드'],
    [/\bCodex\b/gi, '코덱스'],
    [/\bSera\b/g, '세라'],
    [/\bDiscord\b/gi, '디스코드'],
    [/\bElectron\b/gi, '일렉트론'],
    [/\bNode(\.js)?\b/g, '노드'],
    [/\bmacOS\b/g, '맥오에스'],
    [/\bPR\b/g, '피알'],
  ]

  function cleanForSpeech(input, maxChars = MAX_CHARS) {
    if (typeof input !== 'string') return ''
    let t = input
    t = t.replace(/```[\s\S]*?(```|$)/g, ' ')          // fenced code (also an unclosed tail)
    t = t.replace(/<[^>\n]+>/g, ' ')                     // html-ish tags
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
    t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // links -> label
    t = t.replace(/https?:\/\/\S+/g, ' ')                // bare urls
    t = t.replace(/`([^`\n]*)`/g, (m, c) => (c.length > 40 || /[\/\\{}();=]/.test(c) ? ' ' : c)) // inline code: keep short words only
    t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '')             // headings
    t = t.replace(/^\s*>\s?/gm, '')                       // blockquotes
    t = t.replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')         // list markers
    t = t.replace(/^\s*[-*_]{3,}\s*$/gm, ' ')            // hr
    t = t.replace(/^\s*\|.*\|\s*$/gm, ' ')               // table rows
    t = t.replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2') // emphasis
    t = t.replace(/[*_~#|]/g, ' ')
    for (const [re, ko] of NAME_MAP) t = t.replace(re, ko)
    t = t.replace(/\s+/g, ' ').trim()
    if (t.length > maxChars) {
      const cut = t.slice(0, maxChars)
      const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '), cut.lastIndexOf('다. '), cut.lastIndexOf('요. '))
      t = (stop > maxChars * 0.5 ? cut.slice(0, stop + 1) : cut).trim()
    }
    // Nothing pronounceable left (only symbols/digits of a tool dump) -> skip.
    if (!/[A-Za-zㄱ-ㆎ가-힣぀-ヿ一-鿿]/.test(t)) return ''
    return t
  }

  // Serial queue: synth(text) -> Promise<playable>, play(playable) -> Promise (resolves when done).
  // One item at a time; stop() drops pending items and aborts the current one.
  function createSpeechQueue({ synth, play, stopPlayback = () => {}, onState = () => {} }) {
    const pending = []
    let running = false
    let generation = 0
    async function drain() {
      if (running) return
      running = true
      onState('playing')
      try {
        while (pending.length) {
          const gen = generation
          const text = pending.shift()
          try {
            const playable = await synth(text)
            if (gen !== generation) continue
            await play(playable)
          } catch (e) { if (gen === generation) onState('error', e) }
        }
      } finally { running = false; onState('idle') }
    }
    return {
      enqueue(text) { if (text) { pending.push(text); drain() } },
      stop() { generation++; pending.length = 0; stopPlayback() },
      get size() { return pending.length + (running ? 1 : 0) },
      get running() { return running },
    }
  }

  const api = { cleanForSpeech, createSpeechQueue, MAX_CHARS }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.SeraTTSCore = api
})(typeof window !== 'undefined' ? window : globalThis)
