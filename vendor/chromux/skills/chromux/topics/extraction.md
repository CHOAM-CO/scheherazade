# chromux deep guide: extraction and collection

On-demand guide (`chromux skill extraction`). Read when a task is about
pulling structured data out of pages, not clicking through them.

## Find before you dump

- `snapshot <s> --grep "pattern"` — only matching lines plus their ancestors.
  Regex first, literal fallback. This is the default move on any big page.
- `snapshot <s> --interactive` — actionable elements only.
- `snapshot <s> --diff` — only what changed since your previous snapshot.

## Tables

```bash
chromux run <s> --file snippets/_builtin/table-extract.js \
  --arg table='#prices' --arg maxRows=100
```

Returns `{headers, rowCount, truncated, rows}`. Pair with `--schema` so a
layout change fails loudly instead of returning garbage shapes.

## Paginated lists

```bash
chromux run <s> --file snippets/_builtin/paginate-collect.js \
  --arg item='.result' --arg fields='{"title":"h2","url":"a@href"}' \
  --arg next='a[rel="next"]' --arg maxPages=5
```

`fields` maps output keys to `selector` or `selector@attribute` inside each
item. Advancing waits on network-idle, then for items to render. For infinite
scroll instead of pagination, use `scroll-until.js`.

## Aggregations: one run, one JSON

Answer every part of a multi-part question in a single `run` returning one
object; sanity checks belong inside the same call. Model-authored page JS is
expensive output — prefer the snippets above, then a small `js()` reduction.

## Freeze what worked

```bash
chromux script save <host>/<flow> --file flow.js     # replay: run <s> --script <host>/<flow>
```

Replays cost zero model calls; `open` lists saved scripts for the host.
Validate replay output with `--schema contract.json`; keep a `--receipt PATH`
for mutation-adjacent flows.
