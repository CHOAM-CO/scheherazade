// Builtin helper for `chromux run`: extract a table as structured data
// without dumping HTML.
// Usage:
//   chromux run <s> --file snippets/_builtin/table-extract.js \
//     [--arg table='#prices'] [--arg maxRows=200]
// Returns { headers, rowCount, truncated, rows } — pair with --schema for
// validated extraction.
const tableSel = args.table || 'table';
const maxRows = Math.min(Number(args.maxRows) || 200, 2000);
return await js(`((sel, maxRows) => {
  const table = document.querySelector(sel);
  if (!table) throw new Error('No table matching: ' + sel);
  // Nested tables: keep only rows/cells belonging to THIS table, not inner ones.
  const owns = (node) => node.closest('table') === table;
  const headers = [...table.querySelectorAll('thead th, thead td')].filter(owns).map(cell => cell.textContent.trim());
  let bodyRows = [...table.querySelectorAll('tbody tr')].filter(owns);
  if (!bodyRows.length) bodyRows = [...table.querySelectorAll('tr')].filter(owns).filter(tr => !tr.querySelector('th'));
  let hasColspan = false;
  const rows = bodyRows.slice(0, maxRows).map(tr => [...tr.querySelectorAll('td,th')].filter(owns).map(cell => {
    if (Number(cell.getAttribute('colspan')) > 1) hasColspan = true;
    return cell.textContent.trim();
  }));
  const out = { headers, rowCount: bodyRows.length, truncated: bodyRows.length > maxRows, rows };
  // colspans misalign cells against headers — say so instead of validating a
  // wrong shape.
  if (hasColspan) out.hasColspan = true;
  return out;
})(${JSON.stringify(tableSel)}, ${maxRows})`);
