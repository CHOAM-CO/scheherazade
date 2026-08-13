// Builtin helper for `chromux run`.
// Usage:
//   chromux run <session> --file snippets/_builtin/page-extract.js
//
// Returns structured page metadata without storing full body text or HTML.
return await page(`({
  url: location.href,
  title: document.title,
  lang: document.documentElement ? document.documentElement.lang || '' : '',
  canonical: document.querySelector('link[rel="canonical"]')?.href || '',
  description: document.querySelector('meta[name="description"]')?.content || '',
  headings: [...document.querySelectorAll('h1,h2,h3')]
    .slice(0, 20)
    .map(node => ({ tag: node.tagName.toLowerCase(), text: (node.textContent || '').trim().slice(0, 160) }))
    .filter(item => item.text),
  links: [...document.querySelectorAll('a[href]')]
    .slice(0, 80)
    .map(node => ({ text: (node.textContent || '').trim().slice(0, 120), href: node.href }))
    .filter(item => item.href),
  textLength: document.body ? (document.body.textContent || '').length : 0,
  htmlLength: document.documentElement ? document.documentElement.outerHTML.length : 0
})`);
