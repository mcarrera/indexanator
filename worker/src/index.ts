export interface Env {
  SNAPSHOTS: KVNamespace;
  ASSETS: Fetcher;
  GOOGLE_API_KEY: string; // set as dashboard secret, next steps
  SHEET_ID: string;
  SHEET_RANGE: string;
}

type Row = {
  symbol: string;
  name: string;
  marketCap: number | null;
  price: number | null;
  changePct: number | null;
};

type Snapshot = { asOf: string; rows: Row[] };

//  MIRROR LOGIC — keep identical to backend/src/index.ts
function toNumber(v: unknown): number | null {
  if (typeof v === "number" && !isNaN(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/[$,%\s]/g, ""));
    return isNaN(n) ? null : n;
  }
  return null;
}

const MIN_ROWS = 400;

async function pollSheet(env: Env): Promise<Snapshot> {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SHEET_ID}` +
    `/values/${encodeURIComponent(env.SHEET_RANGE)}` +
    `?key=${env.GOOGLE_API_KEY}&valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 300)}`);

 const values = ((await res.json()) as { values?: unknown[][] }).values ?? [];
  const rows: Row[] = [];
  for (const r of values) {
    const [symbol, name, marketCap, price, changePct] = r;
    if (typeof symbol !== "string" || !symbol.trim()) continue;
    const cp = toNumber(changePct);
    rows.push({
      symbol: symbol.trim(),
      name: typeof name === "string" ? name.trim() : "",
      marketCap: toNumber(marketCap),
      price: toNumber(price),
      // percent cells store fractions; contract = percentage points
      changePct: cp === null ? null : toNumber(cp)
    });
  }
  if (rows.length < MIN_ROWS) throw new Error(`Row guard: ${rows.length} rows`);
  return { asOf: new Date().toISOString(), rows };
}
// ⚠️ END MIRROR LOGIC

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/quotes") return env.ASSETS.fetch(request);

    const raw = await env.SNAPSHOTS.get("snapshot");
    if (!raw) return Response.json({ asOf: null, rows: [], degraded: false }, { status: 503 });

    return new Response(raw, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env) {
    try {
      const snap = await pollSheet(env);
      await env.SNAPSHOTS.put("snapshot", JSON.stringify(snap));
      console.log(`[poll] OK — ${snap.rows.length} rows @ ${snap.asOf}`);
    } catch (e) {
      console.log(`[poll] FAILED — ${(e as Error).message} (serving last good)`);
    }
  },
};