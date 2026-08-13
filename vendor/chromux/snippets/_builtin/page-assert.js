// Builtin helper for `chromux run`.
// Usage:
//   chromux run <s> --file snippets/_builtin/page-assert.js --arg selector='#done' --arg text='Saved'
const selector = args.selector || globalThis.selector || 'body';
const text = args.text || globalThis.text || '';
const expression = args.expression || globalThis.expression || 'document.readyState === "complete" || document.readyState === "interactive"';

const checks = [];
checks.push(await waitFor(selector, { kind: 'selector', timeoutMs: 5000 }));
if (text) checks.push(await waitFor(text, { kind: 'text', timeoutMs: 5000 }));
checks.push(await assertPage(expression, { timeoutMs: 1000 }));

return {
  ok: true,
  checks,
  page: await page('({url:location.href,title:document.title})'),
};
