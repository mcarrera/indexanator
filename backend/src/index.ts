import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const SHEET_ID = process.env.SHEET_ID ?? "";
const API_KEY = process.env.GOOGLE_API_KEY ?? "";
const POLL_MS = Number(process.env.POLL_MINUTES ?? 60) * 60_000;
const MARKET_TZ = "America/New_York"; // Eastern, DST-proof via Intl

// ---------------------------------------------------------------------------
// Multi-index configuration
//
// INDEXES is a JSON array; each entry:
//   id      – stable identifier, used in /api/quotes?id=
//   label   – display name (tab title, badge prefix)
//   sheetId – optional per-index sheet id; falls back to SHEET_ID
//   range   – data range "TabName!D2:H520"
//   idxRange– single cell holding the index's daily change ("TabName!K1")
//   minRows – sanity threshold; refuses to serve fewer rows than this
//   description – short per-tab blurb shown under the tab bar
//
// Backwards compatible: if INDEXES is unset, a single S&P 500 entry is built
// from the legacy SHEET_RANGE / SPX_RANGE env vars.
// ---------------------------------------------------------------------------
type IndexConfig = {
  id: string;
  label: string;
  sheetId: string | null;
  range: string;
  idxRange: string | null;
  minRows: number;
  description: string;
};

const DEFAULT_INDEXES: IndexConfig[] = [
  {
    id: "sp500",
    label: "S&P 500",
    sheetId: null,
    range: process.env.SHEET_RANGE ?? "Sheet1!D2:H520",
    idxRange: process.env.SPX_RANGE ?? "Sheet1!K1",
    minRows: Number(process.env.MIN_ROWS ?? 400),
    description: "The S&P 500 — the 500 largest US-listed companies.",
  },
];

function parseIndexes(raw: string | undefined): IndexConfig[] {
  if (!raw?.trim()) return DEFAULT_INDEXES;
  try {
    const parsed = JSON.parse(raw) as Partial<IndexConfig>[];
    const list = parsed
      .filter((c) => typeof c.id === "string" && typeof c.range === "string")
      .map((c) => ({
        id: c.id!,
        label: c.label ?? c.id!,
        sheetId: c.sheetId ?? null,
        range: c.range!,
        idxRange: c.idxRange ?? null,
        minRows: Number(c.minRows ?? 1),
        description: typeof c.description === "string" ? c.description : "",
      }));
    if (list.length === 0) throw new Error("empty");
    return list;
  } catch (err) {
    console.error(
      `[config] Failed to parse INDEXES (${err instanceof Error ? err.message : err}) — falling back to S&P 500 only`
    );
    return DEFAULT_INDEXES;
  }
}

const INDEXES = parseIndexes(process.env.INDEXES);

type Row = {
  symbol: string;
  name: string;
  marketCap: number | null;
  price: number | null;
  changePct: number | null;
};
type Snapshot = { asOf: string; rows: Row[]; indexChangePct: number | null };
type IndexState = {
  config: IndexConfig;
  snapshot: Snapshot | null;
  lastError: string | null;
  lastOkAt: string | null;
};

const states = new Map<string, IndexState>(
  INDEXES.map((config) => [config.id, { config, snapshot: null, lastError: null, lastOkAt: null }])
);

/** Accepts numbers or formatted strings ("$5.1T", "0.06%", "1,234.5"). Percentages are returned as ratios. */
function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const text = v.trim();
    const isPercent = text.endsWith("%");
    const n = Number(text.replace(/[^0-9.\-]/g, ""));
    if (Number.isFinite(n)) return isPercent ? n / 100 : n;
  }
  return null;
}

/** True Mon–Fri, 9:00–17:00 Eastern (approximation — ignores US holidays). */
function isMarketOpen(): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MARKET_TZ,
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return wd !== "Sat" && wd !== "Sun" && hour >= 9 && hour < 17;
}

function sheetsUrl(sheetId: string, range: string): string {
  return (
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `${encodeURIComponent(range)}?key=${API_KEY}&valueRenderOption=UNFORMATTED_VALUE`
  );
}

/** Fetches an index's daily change from a single cell. Failure is non-fatal — pill just hides. */
async function fetchIndexChange(cfg: IndexConfig): Promise<number | null> {
  if (!cfg.idxRange) return null;
  try {
    const res = await fetch(sheetsUrl(cfg.sheetId ?? SHEET_ID, cfg.idxRange));
    if (!res.ok) return null;
    const j = (await res.json()) as { values?: unknown[][] };
    return toNumber(j.values?.[0]?.[0]);
  } catch {
    return null; // network error, etc
  }
}

async function fetchSnapshot(cfg: IndexConfig): Promise<Snapshot> {
  const [res, indexChangePct] = await Promise.all([
    fetch(sheetsUrl(cfg.sheetId ?? SHEET_ID, cfg.range)),
    fetchIndexChange(cfg),
  ]);
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const data = (await res.json()) as { values?: unknown[][] };
  const rows: Row[] = [];
  for (const r of data.values ?? []) {
    const [symbol, name, marketCap, price, changePct] = r;
    if (typeof symbol !== "string" || !symbol.trim()) continue;
    rows.push({
      symbol: symbol.trim(),
      name: typeof name === "string" ? name.trim() : "",
      marketCap: toNumber(marketCap),
      price: toNumber(price),
      changePct: toNumber(changePct),
    });
  }
  if (rows.length < cfg.minRows)
    throw new Error(`Suspiciously few rows (${rows.length}, min ${cfg.minRows}) — refusing to serve`);
  return { asOf: new Date().toISOString(), rows, indexChangePct };
}

async function poll(force = false): Promise<void> {
  if (!force && !isMarketOpen()) {
    console.log("[poll] skipped — US market closed (last good data still served)");
    setTimeout(poll, POLL_MS);
    return;
  }
  await Promise.all(Array.from(states.values()).map(refreshIndex));
  setTimeout(poll, POLL_MS); // regular ticks: market-gated again
}

/** Refreshes one index; its failures never affect the others. */
async function refreshIndex(state: IndexState): Promise<void> {
  try {
    const snap = await fetchSnapshot(state.config);
    state.snapshot = snap;
    state.lastError = null;
    state.lastOkAt = snap.asOf;
    console.log(
      `[poll/${state.config.id}] OK — ${snap.rows.length} rows @ ${snap.asOf} (idx ${snap.indexChangePct ?? "n/a"})`
    );
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.error(
      `[poll/${state.config.id}] FAILED — ${state.lastError} (serving last good data if any)`
    );
  }
}

const app = express();

app.get("/api/indexes", (_req, res) => {
  // Frontend derives tabs from this, so tabs can never drift from the backend.
  res.json(
    Array.from(states.values()).map(({ config, lastError, lastOkAt }) => ({
      id: config.id,
      label: config.label,
      description: config.description,
      ready: lastOkAt !== null,
      lastError: lastError ?? null,
    }))
  );
});

app.get("/api/quotes", (req, res) => {
  const id = typeof req.query.id === "string" ? req.query.id : INDEXES[0]?.id ?? "sp500";
  const state = states.get(id);
  if (!state) {
    res.status(404).json({ error: `Unknown index "${id}"` });
    return;
  }
  if (state.snapshot) {
    res.json({
      id: state.config.id,
      label: state.config.label,
      ...state.snapshot,
      degraded: state.lastError !== null,
      marketOpen: isMarketOpen(),
    });
  } else {
    res.status(503).json({ error: state.lastError ?? "No data yet — first poll still running" });
  }
});

app.get("/healthz", (_req, res) => {
  const indexes = Array.from(states.values()).map(({ config, snapshot, lastError }) => ({
    id: config.id,
    hasData: snapshot !== null,
    rows: snapshot?.rows.length ?? 0,
    lastError,
  }));
  res.json({
    ok: indexes.every((i) => i.hasData),
    indexes,
  });
});

// --- static frontend
const FRONTEND_DIR = path.join(__dirname, "..", "public");

app.use(express.static(FRONTEND_DIR));

app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});
// --- end static frontend

app.listen(PORT, () => {
  console.log(
    `Backend on :${PORT} — polling ${states.size} index(es): ` +
      Array.from(states.values())
        .map((s) => `${s.config.id} [${s.config.range}]`)
        .join(", ") +
      ` every ${POLL_MS / 60_000} min`
  );
});
poll(true); // first poll immediately at boot
