const { useState, useMemo, useEffect } = React;

const REFRESH_MS = 2 * 60 * 1000; // refresh every 2 minutes

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
    const [tabs, setTabs] = useState([]);        // [{id,label,ready,lastError}]
    const [activeId, setActiveId] = useState(null);
    const [data, setData] = useState(null);       // rows of the active index
    const [meta, setMeta] = useState(null);       // {id,label,asOf,degraded,marketOpen,indexChangePct}
    const [error, setError] = useState(null);
    const [filter, setFilter] = useState("");
    const [sortKey, setSortKey] = useState("marketCap");
    const [sortDir, setSortDir] = useState("desc");

    // Reset the table view when switching tabs — different indexes,
    // different membership, stale sort/filter state would be confusing.
    const selectTab = id => {
        if (id === activeId) return;
        setActiveId(id);
        setFilter("");
        setSortKey("marketCap");
        setSortDir("desc");
        setData(null);
        setMeta(null);
        setError(null);
    };

    const load = () => {
        const q = activeId ? "?id=" + encodeURIComponent(activeId) : "";
        fetch("/api/quotes" + q)
            .then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
            .then(j => {
                setData(j.rows);
                setMeta(j);
                setError(null);
            })
            .catch(e => setError(String(e)));
    };

    useEffect(() => {
        // 1) Discover tabs from the backend so UI and config can never drift
        fetch("/api/indexes")
            .then(r => r.json())
            .then(list => {
                setTabs(list);
                if (list.length > 0) setActiveId(prev => prev ?? list[0].id);
            })
            .catch(e => setError(String(e)));
    }, []);

    useEffect(() => {
        if (!activeId) return;
        load();
        const t = setInterval(load, REFRESH_MS);
        return () => clearInterval(t);
    }, [activeId]);

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

    if (tabs.length === 0 && !error) return <p>Loading…</p>;

    // single source of truth for staleness — gated on market hours
    const marketOpen = meta?.marketOpen ?? true;
    const asOf = meta?.asOf ?? null;
    const stale = marketOpen && asOf && (Date.now() - new Date(asOf).getTime() > 3 * 60 * 60 * 1000);
    const asOfStr = asOf ? new Date(asOf).toLocaleString("en-GB", { timeZone: "UTC", dateStyle: "medium", timeStyle: "medium", hour12: false }) + " UTC" : "";
    const idxPct = meta?.indexChangePct ?? null;
    const activeTab = tabs.find(t => t.id === activeId);

    return (
        <div className="wrap">
            <div className="page-head">
                <h1>Indexanator: Market Snapshot</h1>
                <div className="sub">Quotes are delayed and might be inaccurate. This site is for general information only - nothing here is investment advice or a recommendation to buy or sell any security. Use of this site is entirely at your own risk; the operator is not liable for any losses arising from reliance on its content.</div>
            </div>

            <div className="tabs" role="tablist">
                {tabs.map(t => (
                    <button key={t.id}
                        role="tab"
                        aria-selected={t.id === activeId}
                        className={"tab" + (t.id === activeId ? " active" : "") + (t.ready ? "" : " not-ready")}
                        onClick={() => selectTab(t.id)}>
                        {t.label}
                        {!t.ready && <span className="tab-wait" title="no data yet — waiting for first successful poll">(pending)</span>}
                    </button>
                ))}
            </div>

            {activeTab && !activeTab.ready ? (
                <p className="error-msg">No data yet for {activeTab.label} — the backend hasn't completed a successful poll for this index. {activeTab.lastError ? "Last error: " + activeTab.lastError : ""}</p>
            ) : (
                <>
                    <div className="badges">
                        <div className={"badge " + ((meta && (meta.degraded || stale)) ? "degraded" : "")}>
                            {(meta && meta.degraded) && "Upstream issue, showing last good data. "}
                            {stale && "Data appears stale. "}
                            {!marketOpen && !(meta && meta.degraded) && "US market closed. "}
                            {asOfStr && `Data last read at ${asOfStr}`}
                        </div>
                        {idxPct != null && (
                            <span className={"badge spx " + (idxPct >= 0 ? "pos" : "neg")}>
                                {(meta.label || "Index")} {idxPct >= 0 ? "\u25B2" : "\u25BC"} {fmtPct(idxPct)}
                            </span>
                        )}
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
                                {error && !data && <tr><td colSpan={COLUMNS.length}>Failed to load data: {error}</td></tr>}
                                {data && rows.length === 0 && <tr><td colSpan={COLUMNS.length}>No matches.</td></tr>}
                                {rows.map(r => {
                                    const cls = r.changePct > 0 ? "pos" : r.changePct < 0 ? "neg" : "";
                                    return (
                                        <tr key={r.symbol}>
                                            <td><a href={"https://stockanalysis.com/stocks/" + r.symbol} target="_blank" rel="noopener noreferrer">{r.symbol}</a></td>
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
                        Source: Google Sheet → Sheets API → cached snapshot. {data ? rows.length + " of " + data.length + " rows shown." : ""}
                    </div>
                </>
            )}
        </div>
    );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
