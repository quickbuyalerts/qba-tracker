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

    const discoveredAddrs = new Set();
    for (const raw of rawPairs) {
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

      // Stagger: 2s between pairs
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] OHLCV error for ${addr}:`, err.message);
    }
  }

  lastOhlcvUpdate = Date.now();
  if (updated.length) {
    broadcast("update", { pairs: updated, stats: getStats() });
  }
  console.log(`[${new Date().toISOString()}] OHLCV updated for ${updated.length} pairs`);
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
