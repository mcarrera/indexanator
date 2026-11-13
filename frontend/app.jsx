const { useState, useMemo, useEffect } = React;

const REFRESH_MS = 5 * 60 * 1000; // refresh every 5 minutes

const fmtCap = n => {
    if (n == null) return "—";
    if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
    if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
    return "$" + n.toLocaleString("en-US");
};
const fmtPrice = n => (n == null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2 }));
const fmtName = n => (n == null ? "—" : n.replace(/\s*Common Stock$/i, ""));
const fmtPct = n => {
    if (n == null) return "—";
    const v = n * 100;
    return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
};

const COLUMNS = [
    { key: "symbol", label: "Symbol", align: "left", w: "10%" },
    { key: "name", label: "Name", align: "left", w: "38%" },
    { key: "marketCap", label: "Market Cap", w: "16%" },
    { key: "price", label: "Current Price", w: "16%" },
    { key: "changePct", label: "Daily Change", w: "20%" },
];

function App() {
    const [data, setData] = useState(null);
    const [asOf, setAsOf] = useState(null);
    const [degraded, setDegraded] = useState(false);
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState("");
    const [sortKey, setSortKey] = useState("marketCap");
    const [sortDir, setSortDir] = useState("desc");

    const load = () => {
        fetch("/api/quotes")
            .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(j => { setData(j.rows); setAsOf(j.asOf); setDegraded(!!j.degraded); setError(null); })
            .catch(e => setError(String(e)));
    };

    useEffect(() => {
        load();
        const t = setInterval(load, REFRESH_MS);
        return () => clearInterval(t);
    }, []);

    const rows = useMemo(() => {
        if (!data) return [];
        const f = filter.trim().toUpperCase();
        let out = f ? data.filter(r => r.symbol.toUpperCase().includes(f) ||
            r.name.toUpperCase().includes(f)) : [...data];
        out.sort((a, b) => {
            const va = a[sortKey] ?? (typeof a[sortKey] === "string" ? "" : -Infinity);
            const vb = b[sortKey] ?? (typeof b[sortKey] === "string" ? "" : -Infinity);
            const cmp = typeof va === "string" ? va.localeCompare(vb) : va - vb;
            return sortDir === "asc" ? cmp : -cmp;
        });
        return out;
    }, [data, filter, sortKey, sortDir]);

    const onSort = key => {
        if (key === sortKey) { setSortDir(d => d === "asc" ? "desc" : "asc"); }
        else { setSortKey(key); setSortDir(key === "symbol" ? "asc" : "desc"); }
    };
    const arrow = key => (sortKey !== key ? "" : sortDir === "asc" ? " \u2191" : " \u2193");

    if (error && !data) return <p style={{ color: "#b71c1c" }}>Failed to load data: {error}</p>;
    if (!data) return <p>Loading…</p>;

    const asOfStr = asOf ? new Date(asOf).toLocaleTimeString() : "";
    const stale = asOf && (Date.now() - new Date(asOf).getTime() > 3 * 60 * 60 * 1000);

    return (
        <div className="wrap">
            <div className="page-head">
                <h1>Indexator — S&amp;P Snapshot</h1>
                <div className="sub">Quotes delayed — informational only, not for trading purposes.</div>
            </div>

            <div className={"badge " + (degraded || stale ? "degraded" : "")}>
                {degraded && "Upstream issue — showing last good data. "}
                {stale && "Data appears stale. "}
                {asOfStr && `Data last read at ${asOfStr}`}
            </div>

            <div className="toolbar">
                <input placeholder="Filter by symbol or name…" value={filter}
                    onChange={e => setFilter(e.target.value)} />
            </div>

            <div className="table-wrap">
                <table>
                    <colgroup>
                        {COLUMNS.map(c => <col key={c.key} style={{ width: c.w }} />)}
                    </colgroup>
                    <thead>
                        <tr>
                            {COLUMNS.map(c => (
                                <th key={c.key} className={c.align === "left" ? "left-col" : ""}
                                    onClick={() => onSort(c.key)} style={{ textAlign: c.align || "right" }}>
                                    {c.label}{arrow(c.key)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.length === 0 && <tr><td colSpan={COLUMNS.length}>No matches.</td></tr>}
                        {rows.map(r => {
                            const cls = r.changePct > 0 ? "pos" : r.changePct < 0 ? "neg" : "";
                            return (
                                <tr key={r.symbol}>
                                    <td>{r.symbol}</td>
                                    <td className="name-cell">{fmtName(r.name)}</td>
                                    <td>{fmtCap(r.marketCap)}</td>
                                    <td>{fmtPrice(r.price)}</td>
                                    <td className={"change-cell " + cls}>{fmtPct(r.changePct)}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <div className="footer-note">
                Source: Google Sheet → Sheets API → cached snapshot. {rows.length} of {data.length} rows shown.
            </div>
        </div>
    ); ß
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
