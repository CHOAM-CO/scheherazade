// Builtin helper for `chromux run`: drive a multi-step wizard — fill each
// step's fields, advance, wait for the next step to render — in one call.
// Usage:
//   chromux run <s> --file snippets/_builtin/wizard-flow.js \
//     --arg steps='[{"fields":{"#name":"Jane"},"next":"#to-step2","waitText":"Step 2"},
//                   {"fields":{"#plan":"Team"},"next":"#finish","waitText":"All done"}]' \
//     [--arg report='#status']
// Each step: fields (selector/@ref -> value, optional), next (selector/@ref
// to advance, optional on the last step), waitText or waitSelector (proof the
// step advanced). Returns per-step receipts plus the report element's text.
const cssOf = (sel) => /^@\d+$/.test(sel) ? `[data-ct-ref="${sel.slice(1)}"]` : sel;
const steps = Array.isArray(args.steps) ? args.steps : null;
if (!steps || !steps.length) throw new Error('wizard-flow requires --arg steps=[{fields, next, waitText|waitSelector}]');
const KNOWN_STEP_KEYS = new Set(['fields', 'next', 'waitText', 'waitSelector']);
for (const [index, step] of steps.entries()) {
  const unknown = Object.keys(step || {}).filter(key => !KNOWN_STEP_KEYS.has(key));
  if (unknown.length) throw new Error(`wizard-flow step ${index + 1} has unknown keys: ${unknown.join(', ')} (known: fields, next, waitText, waitSelector)`);
  // "Per-step readiness proof" is the whole point: every advancing step must
  // prove the wizard actually moved on.
  if (index < steps.length - 1 && !step.waitText && !step.waitSelector) {
    throw new Error(`wizard-flow step ${index + 1} advances but has no waitText/waitSelector readiness proof`);
  }
}
const reportSelector = args.report || '';

// Mirrors the realm-safe setter + events idiom of chromux.mjs /fill and
// form-flow.js; keep the three in sync.
const fillOne = async (sel, val) => js(`((sel, txt) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('Missing wizard field: ' + sel);
  el.focus();
  const view = el.ownerDocument.defaultView || window;
  if (el.tagName === 'SELECT') {
    const opts = Array.from(el.options);
    const match = opts.find(o => o.value === txt)
      || opts.find(o => o.textContent.trim() === txt)
      || opts.find(o => o.textContent.trim().toLowerCase() === txt.toLowerCase());
    if (!match) throw new Error('No option matching "' + txt + '" in ' + sel);
    const setter = Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set;
    if (setter) setter.call(el, match.value); else el.value = match.value;
    el.dispatchEvent(new view.Event('input', { bubbles: true }));
  } else {
    if (!('value' in el)) throw new Error('Field is not fillable via value: ' + sel);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
    if (setter) setter.call(el, txt); else el.value = txt;
    el.dispatchEvent(new view.InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: txt }));
  }
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
  return { tag: el.tagName.toLowerCase(), id: el.id || '' };
})(${JSON.stringify(sel)}, ${JSON.stringify(String(val))})`);

const receipts = [];
for (const [index, step] of steps.entries()) {
  const receipt = { step: index + 1, filled: [] };
  for (const [sel, val] of Object.entries(step.fields || {})) {
    const css = cssOf(sel);
    await waitFor(css, { kind: 'selector', timeoutMs: 8000 });
    receipt.filled.push({ selector: css, ...(await fillOne(css, val)) });
  }
  if (step.next) {
    const nextCss = cssOf(step.next);
    await waitFor(nextCss, { kind: 'selector', timeoutMs: 8000 });
    await js(`((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('Missing wizard advance control: ' + sel);
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })(${JSON.stringify(nextCss)})`);
    receipt.advanced = nextCss;
  }
  if (step.waitText) receipt.readiness = await waitFor(String(step.waitText), { kind: 'text', timeoutMs: 8000 });
  else if (step.waitSelector) receipt.readiness = await waitFor(cssOf(String(step.waitSelector)), { kind: 'selector', timeoutMs: 8000 });
  receipts.push(receipt);
}

let report = null;
if (reportSelector) {
  report = await js(`((sel) => {
    const el = document.querySelector(sel);
    return el ? (el.innerText || el.textContent || '').trim().slice(0, 500) : null;
  })(${JSON.stringify(cssOf(reportSelector))})`);
}
const state = await page('({url:location.href,title:document.title})');
return { steps: receipts, report, page: state };
