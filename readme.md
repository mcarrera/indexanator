# Indexator — S&P Snapshot

A almost real time dashboard of S&P 500 constituents with price, market cap, and daily change. Quotes are updated regularly, with a deliberately weird-but-cheap data pipeline.

> **Disclaimer:** Quotes are delayed and informational only. Not for trading purposes. Use at your own risk.

## Multiple indexes (tabs)

The app supports more than one index, shown as tabs in the UI. Each index is one
tab in the same Google Sheet workbook (columns D–H: Symbol, Name, Market Cap,
Curr Price, Daily Change), plus one cell holding the index's own daily change.

Configure via `INDEXES` in `.env` (JSON array):

```
INDEXES=[
  {"id":"sp500","label":"S&P 500","range":"Sheet1!D2:H520","idxRange":"Sheet1!K1","minRows":400},
  {"id":"ndx","label":"NASDAQ-100","range":"NDXLIST!D2:H105","idxRange":"NDXLIST!K1","minRows":95}
]
```

Fields per entry:

- `id` — stable identifier used in `/api/quotes?id=…`
- `label` — tab title and badge name
- `range` — data range; start at row 2 to skip headers
- `idxRange` — optional cell holding the index's daily change (badges hide if missing/unparseable)
- `minRows` — sanity threshold; the poll refuses to serve fewer rows
- `sheetId` — optional; use a different workbook for this index (defaults to `SHEET_ID`)

If `INDEXES` is unset, the backend falls back to a single S&P 500 index built
from the legacy `SHEET_RANGE` / `SPX_RANGE` / `MIN_ROWS` vars.

Notes:

- Row 1 headers are not read; start ranges at row 2.
- Tabs appear as soon as the index is configured, marked "(pending)" until its
  first successful poll (others keep working normally).
- `/healthz` now reports per-index status plus an overall `ok`.

## Endpoints

- `GET /api/indexes` — available indexes (drives the tab bar)
- `GET /api/quotes?id=<index>` — snapshot rows, `asOf`, `degraded`, `marketOpen`, `indexChangePct`
- `GET /healthz` — per-index health summary