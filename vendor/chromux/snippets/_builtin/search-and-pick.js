// Builtin helper for `chromux run`: the type → suggestion → choose → submit
// search pattern in one call. For a bare type-and-pick, prefer
// `chromux fill <s> <sel> "text" --pick "label"`; this snippet adds the
// submit + readiness + report orchestration around it.
// Usage:
//   chromux run <s> --file snippets/_builtin/search-and-pick.js \
//     --arg input='#search' --arg query='seo' --arg pick='Seoul' \
//     [--arg submit='#go'] [--arg readyText='Results'] [--arg report='#summary']
const cssOf = (sel) => /^@\d+$/.test(sel) ? `[data-ct-ref="${sel.slice(1)}"]` : sel;
// Mirrors PICK_CANDIDATE_SEL in chromux.mjs (fill --pick); doc-check asserts
// the two stay identical.
const PICK_SEL = '[role="option"],[role="menuitem"],li,[class*="suggest"] *,[class*="autocomplete"] *,[class*="option"]';
const inputSel = cssOf(args.input || '');
const query = String(args.query ?? '');
const pick = String(args.pick ?? '');
if (!inputSel || !query || !pick) throw new Error('search-and-pick requires --arg input=, --arg query=, --arg pick=');
const submitSel = args.submit ? cssOf(args.submit) : '';
const readyText = args.readyText || '';
const reportSelector = args.report ? cssOf(args.report) : '';

await waitFor(inputSel, { kind: 'selector', timeoutMs: 8000 });
// Same appeared-after-typing guard as the daemon's fill --pick (keep the two
// in sync): mark candidates visible BEFORE typing so a static nav/list item
// matching the pick text can never win the race against the real popup.
await js(`(() => {
  for (const el of document.querySelectorAll(${JSON.stringify(PICK_SEL)})) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) el.setAttribute('data-ct-pick-seen', '1');
  }
  return true;
})()`);
await js(`((sel, txt) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('Missing search input: ' + sel);
  el.focus();
  const view = el.ownerDocument.defaultView || window;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  if (setter) setter.call(el, txt); else el.value = txt;
  el.dispatchEvent(new view.InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: txt }));
  return true;
})(${JSON.stringify(inputSel)}, ${JSON.stringify(query)})`);

// Poll for a visible suggestion matching `pick` (exact > prefix > substring)
// and choose it with real-ish mouse events.
let picked = null;
const deadline = Date.now() + 5000;
while (Date.now() <= deadline && picked == null) {
  picked = await js(`((needle, inputSel) => {
    const lower = needle.trim().toLowerCase();
    const input = document.querySelector(inputSel);
    const labelOf = (el) => ((el.getAttribute && el.getAttribute('aria-label')) || el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ');
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [];
    for (const el of document.querySelectorAll(${JSON.stringify(PICK_SEL)})) {
      if (el.hasAttribute('data-ct-pick-seen')) continue;
      if (input && (el === input || el.contains(input) || input.contains(el))) continue;
      if (!visible(el)) continue;
      const label = labelOf(el);
      if (label && label.length <= 200) candidates.push({ el, label });
    }
    const match = candidates.find(c => c.label.toLowerCase() === lower)
      || candidates.find(c => c.label.toLowerCase().startsWith(lower))
      || candidates.find(c => c.label.toLowerCase().includes(lower));
    if (!match) return null;
    for (const type of ['mouseover', 'mousedown', 'mouseup', 'click']) {
      match.el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
    return match.label.slice(0, 120);
  })(${JSON.stringify(pick)}, ${JSON.stringify(inputSel)})`);
  if (picked == null) await sleep(150);
}
await js(`(() => { for (const el of document.querySelectorAll('[data-ct-pick-seen]')) el.removeAttribute('data-ct-pick-seen'); return true; })()`);
if (picked == null) throw new Error(`No suggestion matching "${pick}" appeared after typing "${query}"`);

let submitted = null;
if (submitSel) {
  submitted = await js(`((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').trim() };
  })(${JSON.stringify(submitSel)})`);
}
let readiness = null;
if (readyText) readiness = await waitFor(String(readyText), { kind: 'text', timeoutMs: 8000 });
let report = null;
if (reportSelector) {
  report = await js(`((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim().slice(0, 500) : null;
  })(${JSON.stringify(reportSelector)})`);
}
const state = await page('({url:location.href,title:document.title})');
return { picked, submitted, readiness, report, page: state };
