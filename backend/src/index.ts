import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 3000);
const SHEET_ID = process.env.SHEET_ID ?? "";
const API_KEY = process.env.GOOGLE_API_KEY ?? "";
const SHEET_RANGE = process.env.SHEET_RANGE ?? "Sheet1!D2:H520";
const POLL_MS = Number(process.env.POLL_MINUTES ?? 60) * 60_000;
const MARKET_TZ = "America/New_York"; // Eastern, DST-proof via Intl

type Row = {
  symbol: string;
  name: string;
  marketCap: number | null;
  price: number | null;
  changePct: number | null;
};
type Snapshot = { asOf: string; rows: Row[] };

let snapshot: Snapshot | null = null;
let lastError: string | null = null;

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

async function fetchSnapshot(): Promise<Snapshot> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/` +
    `${encodeURIComponent(SHEET_RANGE)}?key=${API_KEY}` +
    `&valueRenderOption=UNFORMATTED_VALUE`;

  const res = await fetch(url);
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
  if (rows.length < 400) throw new Error(`Suspiciously few rows (${rows.length}) — refusing to serve`);
  return { asOf: new Date().toISOString(), rows };
}

async function poll(force = false): Promise<void> {
  if (!force && !isMarketOpen()) {
    console.log("[poll] skipped — US market closed (last good data still served)");
    setTimeout(poll, POLL_MS);
    return;
  }
  try {
    const snap = await fetchSnapshot();
    snapshot = snap;
    lastError = null;
    console.log(`[poll] OK — ${snap.rows.length} rows @ ${snap.asOf}`);
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    console.error(`[poll] FAILED — ${lastError} (serving last good data if any)`);
  } finally {
    setTimeout(poll, POLL_MS); // regular ticks: market-gated again
  }
}

const app = express();

app.get("/api/quotes", (_req, res) => {
  if (snapshot) {
    res.json({ ...snapshot, degraded: lastError !== null });
  } else {
    res.status(503).json({ error: lastError ?? "No data yet — first poll still running" });
  }
});

app.get("/healthz", (_req, res) => {
  res.json({ hasData: snapshot !== null, rows: snapshot?.rows.length ?? 0, lastError });
});

// --- static frontend 
const FRONTEND_DIR = path.join(__dirname, "..", "public");

app.use(express.static(FRONTEND_DIR));

app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});
// --- end static frontend 

app.listen(PORT, () => {
  console.log(`Backend on :${PORT} — polling "${SHEET_RANGE}" every ${POLL_MS / 60_000} min`);
});
poll(true); // first poll immediately at boot