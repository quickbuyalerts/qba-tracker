import { discoverPairs, fetchPairStats, fetchOHLCV } from "./fetcher.js";
import { computeRSI } from "./rsi.js";
import { persistState, restoreState } from "./redis.js";

// In-memory state: Map<pairAddress, PairData>
let pairs = new Map();
let collectorStatus = "starting";
let lastDiscovery = null;
let lastStatsUpdate = null;
let lastOhlcvUpdate = null;

// SSE clients
const sseClients = new Set();

export function registerSSEClient(client) {
  sseClients.add(client);
}

export function removeSSEClient(client) {
  sseClients.delete(client);
}

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(msg);
    } catch {
      sseClients.delete(client);
    }
  }
}

export function getSnapshot() {
  return {
    pairs: Object.fromEntries(pairs),
    stats: getStats(),
  };
}

export function getStats() {
  const allPairs = Array.from(pairs.values());
  const rsiValues = allPairs.map((p) => p.rsi5m).filter((v) => v != null);
  return {
    totalPairs: pairs.size,
    overbought: rsiValues.filter((r) => r > 70).length,
    oversold: rsiValues.filter((r) => r < 30).length,
    avgRsi: rsiValues.length ? +(rsiValues.reduce((a, b) => a + b, 0) / rsiValues.length).toFixed(1) : null,
    collectorStatus,
    lastDiscovery,
    lastStatsUpdate,
    lastOhlcvUpdate,
  };
}

function parsePairFromDiscovery(raw) {
  return {
    pairAddress: raw.pairAddress || raw.address,
    baseToken: raw.baseToken || { symbol: "???", name: "Unknown" },
    dexId: raw.dexId || "",
    url: raw.url || "",
    priceUsd: raw.priceUsd ? parseFloat(raw.priceUsd) : null,
    marketCap: raw.marketCap ?? raw.fdv ?? null,
    liquidity: raw.liquidity?.usd ?? null,
    volume24h: raw.volume?.h24 ?? null,
    priceChange24h: raw.priceChange?.h24 ?? null,
    pairCreatedAt: raw.pairCreatedAt ?? null,
    imageUrl: raw.info?.imageUrl ?? null,
  };
}

function updatePairFromStats(existing, raw) {
  return {
    ...existing,
    priceUsd: raw.priceUsd ? parseFloat(raw.priceUsd) : existing.priceUsd,
    marketCap: raw.marketCap ?? raw.fdv ?? existing.marketCap,
    liquidity: raw.liquidity?.usd ?? existing.liquidity,
    volume24h: raw.volume?.h24 ?? existing.volume24h,
    priceChange24h: raw.priceChange?.h24 ?? existing.priceChange24h,
    imageUrl: raw.info?.imageUrl ?? existing.imageUrl,
    updatedAt: Date.now(),
  };
}

// --- Discovery ---
async function runDiscovery() {
  try {
    const data = await discoverPairs();
    const rawPairs = data?.pairs || data?.results || [];
    if (!rawPairs.length) {
      console.log(`[${new Date().toISOString()}] Discovery returned 0 pairs, keeping existing`);
      return;
    }

    // Strict client-side filtering — undefined/missing means EXCLUDE
    const counts = { total: rawPairs.length, chainId: 0, dexId: 0, liquidity: 0, fdv: 0, volume: 0 };
    let filtered = rawPairs.filter((p) => {
      if (p.chainId !== "solana") { counts.chainId++; return false; }
      const dex = (p.dexId || "").toLowerCase();
      if (dex !== "pumpswap" && dex !== "pumpfun") { counts.dexId++; return false; }
      if (typeof p.liquidity?.usd !== "number" || p.liquidity.usd < 10000) { counts.liquidity++; return false; }
      if (typeof p.fdv !== "number" || p.fdv < 30000) { counts.fdv++; return false; }
      if (typeof p.volume?.h24 !== "number" || p.volume.h24 < 80000 || p.volume.h24 > 180000) { counts.volume++; return false; }
      return true;
    });
    console.log(`[${new Date().toISOString()}] Filter: ${counts.total} raw → ${filtered.length} passed | removed: chainId=${counts.chainId} dexId=${counts.dexId} liq=${counts.liquidity} fdv=${counts.fdv} vol=${counts.volume}`);

    // Cap at 20 pairs, sorted by volume descending
    if (filtered.length > 20) {
      filtered.sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0));
      console.log(`[${new Date().toISOString()}] Capping from ${filtered.length} to 20 pairs (by vol24 desc)`);
      filtered = filtered.slice(0, 20);
    }

    if (!filtered.length) {
      console.log(`[${new Date().toISOString()}] All pairs filtered out, keeping existing`);
      return;
    }

    const discoveredAddrs = new Set();
    for (const raw of filtered) {
      const addr = raw.pairAddress || raw.address;
      if (!addr) continue;
      discoveredAddrs.add(addr);

      if (!pairs.has(addr)) {
        const parsed = parsePairFromDiscovery(raw);
        parsed.rsi5m = null;
        parsed.rsi15m = null;
        parsed.ath = null;
        parsed.candles5m = [];
        parsed.updatedAt = Date.now();
        pairs.set(addr, parsed);
      }
    }

    // Remove pairs no longer in discovery
    for (const addr of pairs.keys()) {
      if (!discoveredAddrs.has(addr)) {
        pairs.delete(addr);
      }
    }

    lastDiscovery = Date.now();
    collectorStatus = "running";
    console.log(`[${new Date().toISOString()}] Discovered ${discoveredAddrs.size} pairs, total: ${pairs.size}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Discovery error:`, err.message);
    // Keep last known pair list on failure
  }
}

// --- Live stats ---
async function runStatsUpdate() {
  const addrs = Array.from(pairs.keys());
  if (!addrs.length) return;

  try {
    const results = await fetchPairStats(addrs);
    const updated = [];

    for (const raw of results) {
      const addr = raw.pairAddress;
      if (!addr || !pairs.has(addr)) continue;
      const existing = pairs.get(addr);
      const updatedPair = updatePairFromStats(existing, raw);
      pairs.set(addr, updatedPair);
      updated.push(updatedPair);
    }

    lastStatsUpdate = Date.now();
    if (updated.length) {
      broadcast("update", { pairs: updated, stats: getStats() });
    }
    console.log(`[${new Date().toISOString()}] Stats updated for ${updated.length} pairs`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Stats update error:`, err.message);
  }
}

// --- OHLCV + RSI ---
async function runOhlcvUpdate() {
  const addrs = Array.from(pairs.keys());
  if (!addrs.length) return;

  const updated = [];
  for (const addr of addrs) {
    try {
      const data = await fetchOHLCV(addr);
      const ohlcvList =
        data?.data?.attributes?.ohlcv_list || [];

      if (!ohlcvList.length) continue;

      // ohlcv_list: [[timestamp, open, high, low, close, volume], ...] newest first
      const candles = ohlcvList
        .slice()
        .reverse()
        .map((c) => ({
          t: c[0],
          o: parseFloat(c[1]),
          h: parseFloat(c[2]),
          l: parseFloat(c[3]),
          c: parseFloat(c[4]),
          v: parseFloat(c[5]),
        }));

      const existing = pairs.get(addr);
      if (!existing) continue;

      existing.candles5m = candles;

      // RSI on 5m closes
      const closes5m = candles.map((c) => c.c);
      existing.rsi5m = computeRSI(closes5m, 14);

      // RSI on 15m: aggregate 5m candles into 15m
      const closes15m = aggregate15m(candles);
      existing.rsi15m = computeRSI(closes15m, 14);

      // ATH tracking
      const maxHigh = Math.max(...candles.map((c) => c.h));
      if (existing.ath == null) {
        existing.ath = maxHigh;
      } else if (maxHigh > existing.ath) {
        existing.ath = maxHigh;
      }
      // Also update from live price
      if (existing.priceUsd && existing.priceUsd > existing.ath) {
        existing.ath = existing.priceUsd;
      }

      pairs.set(addr, existing);
      updated.push(existing);

      // Stagger: 10s between pairs to avoid GeckoTerminal rate limits
      await new Promise((r) => setTimeout(r, 10000));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] OHLCV error for ${addr}:`, err.message);
      if (err.message?.includes("429")) {
        console.log(`[${new Date().toISOString()}] Rate limited by GeckoTerminal, waiting 30s`);
        await new Promise((r) => setTimeout(r, 30000));
      }
    }
  }

  lastOhlcvUpdate = Date.now();
  if (updated.length) {
    broadcast("update", { pairs: updated, stats: getStats() });
  }
  console.log(`[${new Date().toISOString()}] OHLCV updated for ${updated.length} pairs`);

  // RSI filter: remove pairs where RSI is outside 25-35 range
  // Only filter if both RSI values have been calculated
  let rsiRemoved = 0;
  for (const [addr, p] of pairs) {
    if (p.rsi5m == null || p.rsi15m == null) continue;
    if (p.rsi5m < 25 || p.rsi5m > 35 || p.rsi15m < 25 || p.rsi15m > 35) {
      pairs.delete(addr);
      rsiRemoved++;
    }
  }
  if (rsiRemoved > 0) {
    console.log(`[${new Date().toISOString()}] RSI filter removed ${rsiRemoved} pairs, ${pairs.size} remaining`);
    broadcast("snapshot", getSnapshot());
  }
}

function aggregate15m(candles5m) {
  const closes = [];
  for (let i = 2; i < candles5m.length; i += 3) {
    closes.push(candles5m[i].c);
  }
  return closes;
}

// --- Redis persistence ---
async function runPersist() {
  try {
    await persistState(pairs);
    console.log(`[${new Date().toISOString()}] Persisted ${pairs.size} pairs to Redis`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Persist error:`, err.message);
  }
}

// --- Start collector ---
export async function startCollector() {
  console.log(`[${new Date().toISOString()}] Starting collector...`);

  // Restore from Redis
  pairs = await restoreState();

  // Initial discovery
  await runDiscovery();

  // Schedule recurring tasks
  setInterval(runDiscovery, 30_000);
  setInterval(runStatsUpdate, 10_000);
  setInterval(runOhlcvUpdate, 60_000);
  setInterval(runPersist, 60_000);

  // Run first stats + ohlcv after a small delay
  setTimeout(runStatsUpdate, 2_000);
  setTimeout(runOhlcvUpdate, 5_000);

  collectorStatus = "running";
  console.log(`[${new Date().toISOString()}] Collector running`);
}
