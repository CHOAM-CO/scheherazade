// Builtin helper for `chromux run`: collect items across paginated pages —
// extract, advance to the next page, wait, repeat.
// Usage:
//   chromux run <s> --file snippets/_builtin/paginate-collect.js \
//     --arg item='.result' --arg next='a[rel="next"]' \
//     [--arg nextText='Next'] [--arg fields='{"title":"h2","url":"a@href"}'] \
//     [--arg maxPages=5]
// `fields` maps output keys to "selector" or "selector@attribute" inside each
// item; without it, each item's normalized text is collected. Returns
// { total, pages, items }.
const itemSel = args.item || args.itemSelector;
if (!itemSel) throw new Error('paginate-collect requires --arg item=<selector>');
const fields = (args.fields && typeof args.fields === 'object') ? args.fields : null;
const nextSel = args.next || '';
const nextText = args.nextText || '';
if (!nextSel && !nextText) throw new Error('paginate-collect requires --arg next=<selector> or --arg nextText=<label>');
const maxPages = Math.min(Number(args.maxPages) || 5, 50);

// Page signature = URL + first item's text: advancing is only trusted once
// this CHANGES, so a slow page can never be silently re-collected as the
// "next" page (duplicated data is worse than a loud stop).
const pageSignature = () => js(`((itemSel) => {
  const el = document.querySelector(itemSel);
  return location.href + '|' + (el ? el.textContent.trim().slice(0, 80) : '');
})(${JSON.stringify(itemSel)})`);

const pages = [];
const items = [];
let stoppedEarly = null;
for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
  await waitFor(itemSel, { kind: 'selector', timeoutMs: 8000 });
  const collected = await js(`((itemSel, fields) => {
    const parse = (el) => {
      if (!fields) return (el.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 300);
      const record = {};
      for (const [name, spec] of Object.entries(fields)) {
        const [sel, attr] = String(spec).split('@');
        const node = sel ? el.querySelector(sel) : el;
        record[name] = node ? (attr ? node.getAttribute(attr) : node.textContent.trim()) : null;
      }
      return record;
    };
    return [...document.querySelectorAll(itemSel)].map(parse);
  })(${JSON.stringify(itemSel)}, ${JSON.stringify(fields)})`);
  items.push(...collected);
  pages.push({ page: pageNo, count: collected.length, url: await js('location.href') });
  if (pageNo === maxPages) break;
  const signature = await pageSignature();
  const advanced = await js(`((nextSel, nextText) => {
    let next = nextSel ? document.querySelector(nextSel) : null;
    if (!next && nextText) {
      next = [...document.querySelectorAll('a,button')].find(el => (el.innerText || '').trim() === nextText);
    }
    if (!next || next.disabled || next.getAttribute('aria-disabled') === 'true') return false;
    next.scrollIntoView({ block: 'center' });
    next.click();
    return true;
  })(${JSON.stringify(nextSel)}, ${JSON.stringify(nextText)})`);
  if (!advanced) break;
  try {
    const deadline = Date.now() + 8000;
    let changed = false;
    while (Date.now() <= deadline) {
      if (await pageSignature().catch(() => null) !== signature) { changed = true; break; }
      await sleep(200);
    }
    if (!changed) { stoppedEarly = `page did not change after clicking next on page ${pageNo}`; break; }
  } catch {
    // navigation in flight can make the probe throw; give it a beat
    await sleep(800);
  }
  await waitFor(null, { kind: 'network-idle', timeoutMs: 8000, idleMs: 400 }).catch(() => sleep(400));
}
const result = { total: items.length, pages, items };
if (stoppedEarly) result.stoppedEarly = stoppedEarly;
return result;
