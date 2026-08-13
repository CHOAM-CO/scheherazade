// Builtin helper for `chromux run`.
// Usage:
//   chromux run <session> --file snippets/_builtin/network-errors.js
//
// Uses browser-observable resource state, not Chrome history or cookies.
const brokenResources = await js(`(() => {
  const resources = [];
  for (const img of document.images || []) {
    if (!img.complete || img.naturalWidth === 0) resources.push({ type: 'img', url: img.currentSrc || img.src || '' });
  }
  for (const node of document.querySelectorAll('script[src],link[rel="stylesheet"][href]')) {
    const tag = node.tagName.toLowerCase();
    const url = node.src || node.href || '';
    if (!url) continue;
    const matching = performance.getEntriesByName(url);
    if (matching.length === 0) resources.push({ type: tag, url });
  }
  return resources.slice(0, 100);
})()`);

const resourceTimings = await js(`performance.getEntriesByType('resource')
  .slice(-100)
  .map(entry => ({
    name: entry.name,
    initiatorType: entry.initiatorType,
    durationMs: Math.round(entry.duration),
    transferSize: entry.transferSize || 0
  }))`);

return {
  url: await js('location.href'),
  brokenResources,
  resourceTimings,
  failureCount: brokenResources.length,
};
