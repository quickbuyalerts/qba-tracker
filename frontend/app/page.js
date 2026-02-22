"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const API_BASE = typeof window !== "undefined" ? "" : "";

function formatPrice(v) {
  if (v == null) return "-";
  if (v < 0.00001) return `$${v.toExponential(2)}`;
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function formatCompact(v) {
  if (v == null) return "-";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function formatPct(v) {
  if (v == null) return "-";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function formatAge(createdAt) {
  if (!createdAt) return "-";
  const ms = Date.now() - createdAt;
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return `${Math.floor(ms / 60000)}m`;
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function truncAddr(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

function CopyAddress({ addr }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(addr);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <span className="copy-addr" onClick={handleCopy} title={addr}>
      {truncAddr(addr)}
      {copied && <span className="copy-tooltip">Copied!</span>}
    </span>
  );
}

function Sparkline({ candles }) {
  if (!candles || candles.length < 2) {
    return <span style={{ color: "var(--text-dim)", fontSize: 11 }}>Chart loading...</span>;
  }
  const closes = candles.slice(-20).map((c) => c.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;
  const w = 120;
  const h = 40;
  const pad = 2;
  const points = closes.map((v, i) => {
    const x = pad + (i / (closes.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");
  const color = closes[closes.length - 1] >= closes[0] ? "var(--accent)" : "var(--red)";
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
    </svg>
  );
}

function getRsiClass(rsi) {
  if (rsi == null) return "neutral";
  if (rsi > 70) return "overbought";
  if (rsi < 30) return "oversold";
  return "neutral";
}

function getRsiBarColor(rsi) {
  if (rsi == null) return "var(--border)";
  if (rsi > 70) return "var(--red)";
  if (rsi < 30) return "var(--accent)";
  return "var(--blue)";
}

function getAthClass(pctFromAth) {
  if (pctFromAth == null) return "";
  if (pctFromAth > -10) return "ath-near";
  if (pctFromAth < -40) return "ath-far";
  return "";
}

const COLUMNS = [
  { key: "symbol", label: "Token", sortKey: (p) => p.baseToken?.symbol?.toLowerCase() || "" },
  { key: "priceUsd", label: "Price", sortKey: (p) => p.priceUsd ?? 0 },
  { key: "marketCap", label: "MCap", sortKey: (p) => p.marketCap ?? 0 },
  { key: "liquidity", label: "Liquidity", sortKey: (p) => p.liquidity ?? 0 },
  { key: "volume24h", label: "24h Vol", sortKey: (p) => p.volume24h ?? 0 },
  { key: "priceChange24h", label: "24h%", sortKey: (p) => p.priceChange24h ?? 0 },
  { key: "rsi", label: "RSI", sortKey: null },
  { key: "athPct", label: "% from ATH", sortKey: null },
  { key: "ath", label: "ATH", sortKey: (p) => p.ath ?? 0 },
  { key: "age", label: "Age", sortKey: (p) => p.pairCreatedAt ?? 0 },
];

function SkeletonRows() {
  const widths = [180, 70, 80, 80, 80, 60, 60, 70, 70, 50];
  return (
    <div className="loading-container">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="skeleton-row">
          {widths.map((w, j) => (
            <div key={j} className="skeleton skeleton-cell" style={{ width: w, flexShrink: 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function Home() {
  const [pairs, setPairs] = useState({});
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sseError, setSseError] = useState(null);
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState("marketCap");
  const [sortDir, setSortDir] = useState("desc");
  const [rsiTimeframe, setRsiTimeframe] = useState("5m");
  const [flashedRows, setFlashedRows] = useState(new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [hoveredRow, setHoveredRow] = useState(null);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  // SSE connection
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    setSseError(null);
    const es = new EventSource(`${API_BASE}/api/stream`);
    eventSourceRef.current = es;

    es.addEventListener("snapshot", (e) => {
      try {
        const data = JSON.parse(e.data);
        setPairs(data.pairs || {});
        setStats(data.stats || null);
        setLoading(false);
        setSseError(null);
      } catch (err) {
        console.error("Snapshot parse error:", err);
      }
    });

    es.addEventListener("update", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.pairs) {
          const updatedAddrs = new Set();
          setPairs((prev) => {
            const next = { ...prev };
            for (const p of data.pairs) {
              const addr = p.pairAddress;
              if (addr) {
                next[addr] = p;
                updatedAddrs.add(addr);
              }
            }
            return next;
          });
          // Flash updated rows
          setFlashedRows(updatedAddrs);
          setTimeout(() => setFlashedRows(new Set()), 1000);
        }
        if (data.stats) setStats(data.stats);
        setRefreshKey((k) => k + 1);
      } catch (err) {
        console.error("Update parse error:", err);
      }
    });

    es.addEventListener("heartbeat", () => {
      // Keep-alive, no action needed
    });

    es.onerror = () => {
      es.close();
      setSseError("Connection lost. Reconnecting...");
      reconnectTimeoutRef.current = setTimeout(connectSSE, 3000);
    };
  }, []);

  useEffect(() => {
    connectSSE();
    return () => {
      if (eventSourceRef.current) eventSourceRef.current.close();
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [connectSSE]);

  // Sort + filter
  const sortedPairs = useMemo(() => {
    let list = Object.values(pairs);

    // Search filter
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          (p.baseToken?.symbol || "").toLowerCase().includes(q) ||
          (p.baseToken?.name || "").toLowerCase().includes(q) ||
          (p.pairAddress || "").toLowerCase().includes(q)
      );
    }

    // Compute sort keys dynamically for RSI and ATH columns
    const getSortValue = (p) => {
      if (sortCol === "rsi") {
        return rsiTimeframe === "5m" ? (p.rsi5m ?? -1) : (p.rsi15m ?? -1);
      }
      if (sortCol === "athPct") {
        if (p.ath == null || p.priceUsd == null) return -9999;
        return ((p.priceUsd - p.ath) / p.ath) * 100;
      }
      const col = COLUMNS.find((c) => c.key === sortCol);
      if (col?.sortKey) return col.sortKey(p);
      return 0;
    };

    list.sort((a, b) => {
      const va = getSortValue(a);
      const vb = getSortValue(b);
      if (typeof va === "string") {
        return sortDir === "asc" ? va.localeCompare(vb) : vb.localeCompare(va);
      }
      return sortDir === "asc" ? va - vb : vb - va;
    });

    return list;
  }, [pairs, search, sortCol, sortDir, rsiTimeframe]);

  const handleSort = (key) => {
    if (sortCol === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(key);
      setSortDir("desc");
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Header */}
      <header className="header">
        <div className="header-left">
          <div className="live-dot" />
          <h1>QBA TRACKER</h1>
        </div>
        <div className="header-right">
          <div className="rsi-selector">
            <button
              className={`rsi-btn ${rsiTimeframe === "5m" ? "active" : ""}`}
              onClick={() => setRsiTimeframe("5m")}
            >
              RSI 5m
            </button>
            <button
              className={`rsi-btn ${rsiTimeframe === "15m" ? "active" : ""}`}
              onClick={() => setRsiTimeframe("15m")}
            >
              RSI 15m
            </button>
          </div>
          <input
            className="search-box"
            type="text"
            placeholder="Search token..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </header>

      {/* Ticker bar */}
      <div className="ticker-bar">
        <span className="filter-tag">SOL</span>
        <span className="filter-tag">PumpSwap + PumpFun</span>
        <span className="filter-tag">Liq &gt; $10K</span>
        <span className="filter-tag">MCap &gt; $30K</span>
        <span className="filter-tag">Age 48-480h</span>
        <span className="filter-tag">24h Vol $80K-$180K</span>
        <span style={{ marginLeft: "auto", color: "var(--text-dim)" }}>
          {stats?.totalPairs ?? 0} pairs tracked
        </span>
        <div key={refreshKey} className="refresh-bar" />
      </div>

      {/* SSE error banner */}
      {sseError && (
        <div className="error-banner">
          <span>&#9888;</span> {sseError}
          <button
            onClick={connectSSE}
            style={{
              marginLeft: 12,
              background: "transparent",
              border: "1px solid var(--red)",
              color: "var(--red)",
              fontFamily: "'Space Mono', monospace",
              fontSize: 10,
              padding: "2px 8px",
              cursor: "pointer",
              borderRadius: 3,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Main content */}
      <div className="table-container" style={{ flex: 1 }}>
        {loading ? (
          <SkeletonRows />
        ) : sortedPairs.length === 0 ? (
          <div className="empty-state">
            <h2>{search ? "No matches found" : "Waiting for data..."}</h2>
            <p>{search ? "Try a different search term" : "The collector is discovering pairs"}</p>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className={sortCol === col.key ? "sorted" : ""}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.label}
                    {sortCol === col.key && (
                      <span className="sort-arrow">{sortDir === "asc" ? "▲" : "▼"}</span>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedPairs.map((pair) => {
                const rsi = rsiTimeframe === "5m" ? pair.rsi5m : pair.rsi15m;
                const pctFromAth =
                  pair.ath != null && pair.priceUsd != null
                    ? ((pair.priceUsd - pair.ath) / pair.ath) * 100
                    : null;

                return (
                  <tr
                    key={pair.pairAddress}
                    className={flashedRows.has(pair.pairAddress) ? "flash-row" : ""}
                    onMouseEnter={() => setHoveredRow(pair.pairAddress)}
                    onMouseLeave={() => setHoveredRow(null)}
                    style={{ position: "relative" }}
                  >
                    {/* Token */}
                    <td>
                      <div className="token-cell">
                        {pair.imageUrl ? (
                          <img
                            className="token-icon"
                            src={pair.imageUrl}
                            alt=""
                            onError={(e) => {
                              e.target.style.display = "none";
                            }}
                          />
                        ) : (
                          <div className="token-icon" />
                        )}
                        <div className="token-info">
                          <span className="token-symbol">{pair.baseToken?.symbol || "???"}</span>
                          <div className="token-meta">
                            {pair.dexId && <span className="dex-tag">{pair.dexId}</span>}
                            <CopyAddress addr={pair.pairAddress} />
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Price */}
                    <td>{formatPrice(pair.priceUsd)}</td>
                    {/* MCap */}
                    <td>{formatCompact(pair.marketCap)}</td>
                    {/* Liquidity */}
                    <td>{formatCompact(pair.liquidity)}</td>
                    {/* 24h Vol */}
                    <td>{formatCompact(pair.volume24h)}</td>
                    {/* 24h% */}
                    <td className={pair.priceChange24h >= 0 ? "positive" : "negative"}>
                      {formatPct(pair.priceChange24h)}
                    </td>
                    {/* RSI */}
                    <td>
                      <div className="rsi-cell">
                        {rsi != null ? (
                          <>
                            <span className={`rsi-badge ${getRsiClass(rsi)}`}>
                              {rsi.toFixed(1)}
                            </span>
                            <div className="rsi-bar">
                              <div
                                className="rsi-bar-fill"
                                style={{
                                  width: `${Math.min(100, rsi)}%`,
                                  background: getRsiBarColor(rsi),
                                }}
                              />
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>-</span>
                        )}
                      </div>
                    </td>
                    {/* % from ATH */}
                    <td className={getAthClass(pctFromAth)}>
                      {pctFromAth != null ? formatPct(pctFromAth) : "-"}
                    </td>
                    {/* ATH */}
                    <td>{formatPrice(pair.ath)}</td>
                    {/* Age */}
                    <td>
                      {formatAge(pair.pairCreatedAt)}
                      {hoveredRow === pair.pairAddress && (
                        <div className="sparkline-popup">
                          <Sparkline candles={pair.candles5m} />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-stats">
          <div className="footer-stat">
            <span className="label">Pairs:</span>
            <span className="value">{stats?.totalPairs ?? 0}</span>
          </div>
          <div className="footer-stat">
            <span className="label">Overbought:</span>
            <span className="value" style={{ color: "var(--red)" }}>
              {stats?.overbought ?? 0}
            </span>
          </div>
          <div className="footer-stat">
            <span className="label">Oversold:</span>
            <span className="value" style={{ color: "var(--accent)" }}>
              {stats?.oversold ?? 0}
            </span>
          </div>
          <div className="footer-stat">
            <span className="label">Avg RSI:</span>
            <span className="value">{stats?.avgRsi ?? "-"}</span>
          </div>
        </div>
        <div className="status-badge">
          <div className={`dot ${stats?.collectorStatus === "running" ? "running" : "error"}`} />
          <span>Collector: {stats?.collectorStatus ?? "unknown"}</span>
        </div>
      </footer>
    </div>
  );
}
