// markdown.js -- render agent/user message text as markdown, WITHOUT innerHTML.
//
// chat.js has carried "textContent ONLY -- message text (either side's) never
// rides innerHTML" since the in-app chat shipped, and that invariant is not
// negotiable: the text in a bubble is model output and forwarded human text,
// i.e. exactly the content an injection would arrive in. The usual way to add
// markdown is to build an HTML string and assign innerHTML, which trades that
// guarantee away for formatting.
//
// So this builds DOM nodes instead. Every piece of message text reaches the
// page through createTextNode/textContent; no string this module produces is
// ever parsed as HTML. The only attribute ever set from message content is a
// link href, and only after an explicit http(s) test -- main.cjs's
// setWindowOpenHandler then routes it to shell.openExternal and denies
// everything else, so a non-web scheme has no path even if this check were
// wrong.
//
// Deliberately small. This covers what the agent actually emits (the owner
// 2026-08-03: "이런식으로 md문법 안받거든") -- bold, italic, inline code, fences,
// lists, headings, quotes, links. It is not a CommonMark implementation and
// should not grow into one; anything it does not recognise renders as the
// literal characters the model typed, which is the current behaviour and a
// safe floor.

;(function (global) {
  const INLINE = [
    // Inline code FIRST: whatever is inside a backtick span must not then be
    // re-scanned for bold/italic, or `**kwargs` renders as bold "kwargs".
    { re: /`([^`\n]+)`/, tag: 'code' },
    { re: /\*\*([^*\n]+)\*\*/, tag: 'strong' },
    { re: /__([^_\n]+)__/, tag: 'strong' },
    { re: /(?<![*\w])\*([^*\n]+)\*(?!\w)/, tag: 'em' },
    { re: /~~([^~\n]+)~~/, tag: 's' },
  ]
  const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/
  const BARE_URL = /(https?:\/\/[^\s<>"']+)/

  function appendLink(parent, label, href) {
    // Re-tested here rather than trusting the capture group: this is the one
    // place message content becomes an attribute instead of a text node.
    if (!/^https?:\/\//i.test(href)) {
      parent.appendChild(document.createTextNode(label))
      return
    }
    const a = document.createElement('a')
    a.href = href
    a.target = '_blank'
    a.rel = 'noopener noreferrer'
    a.textContent = label
    parent.appendChild(a)
  }

  // Walks a single line, splitting on the earliest match among the inline
  // rules. Recurses into the captured content so **bold with `code`** works,
  // and terminates because every recursion is on a strictly shorter string.
  function renderInline(parent, text) {
    if (!text) return
    let best = null
    const link = LINK.exec(text)
    if (link) best = { index: link.index, len: link[0].length, kind: 'link', m: link }
    for (const rule of INLINE) {
      const m = rule.re.exec(text)
      if (m && (!best || m.index < best.index)) {
        best = { index: m.index, len: m[0].length, kind: 'inline', m, tag: rule.tag }
      }
    }
    if (!best) {
      const bare = BARE_URL.exec(text)
      if (bare) {
        parent.appendChild(document.createTextNode(text.slice(0, bare.index)))
        appendLink(parent, bare[1], bare[1])
        renderInline(parent, text.slice(bare.index + bare[1].length))
        return
      }
      parent.appendChild(document.createTextNode(text))
      return
    }
    parent.appendChild(document.createTextNode(text.slice(0, best.index)))
    if (best.kind === 'link') {
      appendLink(parent, best.m[1], best.m[2])
    } else {
      const el = document.createElement(best.tag)
      // Code spans are literal by definition -- recursing would let a backtick
      // span reintroduce formatting the author escaped ON PURPOSE.
      if (best.tag === 'code') el.textContent = best.m[1]
      else renderInline(el, best.m[1])
      parent.appendChild(el)
    }
    renderInline(parent, text.slice(best.index + best.len))
  }

  function flushList(parent, items, ordered) {
    if (!items.length) return
    const list = document.createElement(ordered ? 'ol' : 'ul')
    for (const item of items) {
      const li = document.createElement('li')
      renderInline(li, item)
      list.appendChild(li)
    }
    parent.appendChild(list)
  }

  function flushPara(parent, lines) {
    if (!lines.length) return
    const p = document.createElement('p')
    lines.forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'))
      renderInline(p, line)
    })
    parent.appendChild(p)
  }

  function renderMarkdown(el, text) {
    el.textContent = ''
    const lines = String(text == null ? '' : text).split('\n')
    let para = []
    let items = []
    let ordered = false

    const flush = () => {
      flushPara(el, para); para = []
      flushList(el, items, ordered); items = []
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const fence = /^\s*```(\S*)\s*$/.exec(line)
      if (fence) {
        flush()
        const body = []
        i++
        // An unterminated fence consumes the rest of the message rather than
        // reverting to prose: a half-streamed code block is still code, and
        // re-parsing its contents as markdown is the uglier failure.
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++])
        const pre = document.createElement('pre')
        const code = document.createElement('code')
        if (fence[1]) code.dataset.lang = fence[1]
        code.textContent = body.join('\n')
        pre.appendChild(code)
        el.appendChild(pre)
        continue
      }
      if (!line.trim()) { flush(); continue }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      if (heading) {
        flush()
        const h = document.createElement(`h${heading[1].length + 2 > 6 ? 6 : heading[1].length + 2}`)
        renderInline(h, heading[2])
        el.appendChild(h)
        continue
      }
      if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flush()
        el.appendChild(document.createElement('hr'))
        continue
      }
      const quote = /^\s*>\s?(.*)$/.exec(line)
      if (quote) {
        flush()
        const bq = document.createElement('blockquote')
        renderInline(bq, quote[1])
        el.appendChild(bq)
        continue
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
      const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
      if (bullet || numbered) {
        const nowOrdered = Boolean(numbered)
        // A list that switches type mid-run is two lists, not one mislabeled
        // one -- flush before the kind changes or the <ol>/<ul> lies.
        if (items.length && nowOrdered !== ordered) { flushList(el, items, ordered); items = [] }
        flushPara(el, para); para = []
        ordered = nowOrdered
        items.push((bullet || numbered)[1])
        continue
      }
      if (items.length) { flushList(el, items, ordered); items = [] }
      para.push(line)
    }
    flush()
  }

  global.renderMarkdown = renderMarkdown
})(window)
