// test-chat-markdown.mjs -- run: node tests/test-chat-markdown.mjs
//
// Loads the REAL onboarding/public/js/markdown.js against a minimal DOM shim,
// so these assertions break when that file changes rather than when a copy of
// it does. The three that matter most are the injection cases: message text is
// model output and forwarded human text, and the bubble renderer's standing
// rule is that none of it may ever be parsed as HTML. If `javascript:` ever
// becomes an href, or a literal <img onerror> stops arriving as text, the
// markdown feature has quietly traded away the guarantee it was built inside.
import fs from 'node:fs'
const nodes = []
function mk(tag) {
  const el = {
    tag, children: [], attrs: {}, dataset: {}, _text: '',
    appendChild(c) { this.children.push(c); return c },
    set textContent(v) { this.children = []; this._text = String(v) },
    get textContent() { return this._text },
    set href(v) { this.attrs.href = v }, get href() { return this.attrs.href },
    set target(v) { this.attrs.target = v }, set rel(v) { this.attrs.rel = v },
  }
  nodes.push(el); return el
}
const document = {
  createElement: mk,
  createTextNode: (t) => ({ tag: '#text', _text: String(t), children: [], get textContent() { return this._text } }),
}
const window = {}
global.document = document; global.window = window
new Function('window', 'document', fs.readFileSync(new URL('../onboarding/public/js/markdown.js', import.meta.url), 'utf8'))(window, document)

function serialize(el) {
  if (el.tag === '#text') return el._text
  const inner = el._text || el.children.map(serialize).join('')
  const attrs = el.attrs.href ? ` href="${el.attrs.href}"` : ''
  return `<${el.tag}${attrs}>${inner}</${el.tag}>`
}
function run(name, input, mustContain, mustNotContain) {
  const root = mk('div')
  window.renderMarkdown(root, input)
  const out = root.children.map(serialize).join('')
  const okc = mustContain.every((s) => out.includes(s))
  const okn = (mustNotContain || []).every((s) => !out.includes(s))
  console.log(`${okc && okn ? '  ok  ' : 'FAIL  '}${name}${okc && okn ? '' : ` -- got: ${out}`}`)
  return okc && okn
}
let ok = 0, bad = 0
const t = (...a) => (run(...a) ? ok++ : bad++)
t('bold', '**핵심**이야', ['<strong>핵심</strong>'])
t('inline code keeps ** literal', 'use `**kwargs` here', ['<code>**kwargs</code>'], ['<strong>'])
t('italic', 'this is *very* good', ['<em>very</em>'])
t('bullets', '- one\n- two', ['<ul>', '<li>one</li>', '<li>two</li>'])
t('numbered', '1. first\n2. second', ['<ol>', '<li>first</li>'])
t('heading', '## Title', ['<h4>Title</h4>'])
t('fence', '```js\nconst a=1\n```', ['<pre>', '<code>const a=1</code>'])
t('quote', '> quoted', ['<blockquote>quoted</blockquote>'])
t('link', '[docs](https://example.com/x)', ['<a href="https://example.com/x">docs</a>'])
t('bare url', 'see https://example.com now', ['<a href="https://example.com">'])
t('javascript: scheme is NOT a link', '[click](javascript:alert(1))', ['click'], ['href='])
t('html is inert text', '<img src=x onerror=alert(1)>', ['<img src=x onerror=alert(1)>'.replace('<','<')], [])
t('bold inside list item', '- **a** b', ['<li><strong>a</strong> b</li>'])
t('script syntax is inert and preserved in code', '```html\n<script>alert(1)</script>\n```', ['<code><script>alert(1)</script></code>'])
t('unclosed script prose never swallows text', '<script>literal\nkeep this', ['literal', 'keep this'])
t('plain text unchanged', 'hello there', ['hello there'])

// CSS regression pin, not a renderer test: the markdown renderer wraps plain
// message text in real <p> nodes, and app.css's global `p` rule dims document
// prose to --fg-dim. Without `color: inherit` on .chat-msg p, plain chat text
// silently renders dim while li/strong keep the bubble color (Mino,
// 2026-08-04: "평문 너무 어둡게 나옴, 불릿포인트나 볼드처리된건 흰색인데").
{
  const css = fs.readFileSync(new URL('../onboarding/public/css/app.css', import.meta.url), 'utf8')
  const rule = css.match(/\.chat-msg p \{[^}]*\}/)
  const pass = rule && /color:\s*inherit/.test(rule[0])
  if (pass) { ok++; console.log('  ok   .chat-msg p keeps color: inherit (global p rule dims prose)') }
  else { bad++; console.log('  FAIL .chat-msg p lost color: inherit -- plain chat text goes dim again') }
}
console.log(`\n${ok} passed, ${bad} failed`)
process.exit(bad ? 1 : 0)
