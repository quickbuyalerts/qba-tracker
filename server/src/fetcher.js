import { dexLimiter, geckoLimiter, discoveryLimiter } from "./rateLimiter.js";

const MAX_RETRIES = 3;
const BASE_DELAY = 1000;

async function fetchWithRetry(url, limiter, retries = MAX_RETRIES) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await limiter.acquire();
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "Mozilla/5.0 (compatible; QBATracker/1.0)",
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      return await res.json();
    } catch (err) {
      if (attempt === retries) {
        throw err;
      }
      const delay = BASE_DELAY * Math.pow(2, attempt);
      console.error(
        `[${new Date().toISOString()}] Retry ${attempt + 1}/${retries} for ${url}: ${err.message}. Waiting ${delay}ms`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

let isFirstDiscovery = true;

const SEARCH_QUERIES = ["pump", "sol", "meme", "cat", "dog"];
const MIN_AGE_MS = 48 * 3600_000;   // 48 hours
const MAX_AGE_MS = 480 * 3600_000;  // 480 hours

/**
 * Discover pairs via official Dexscreener search API with client-side filtering.
 * Runs multiple search queries in parallel and deduplicates by pairAddress.
 */
export async function discoverPairs() {
  // Fetch all queries in parallel
  const results = await Promise.allSettled(
    SEARCH_QUERIES.map((q) =>
      fetchWithRetry(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`, discoveryLimiter)
    )
  );

  // Deduplicate by pairAddress
  const seen = new Set();
  const rawPairs = [];
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value?.pairs) continue;
    for (const p of r.value.pairs) {
      if (!seen.has(p.pairAddress)) {
        seen.add(p.pairAddress);
        rawPairs.push(p);
      }
    }
  }

  // Log raw response structure on first call
  if (isFirstDiscovery) {
    isFirstDiscovery = false;
    const samplePair = rawPairs[0];
    console.log(`[${new Date().toISOString()}] === FIRST DISCOVERY RAW RESPONSE ===`);
    if (samplePair) {
      console.log(`[${new Date().toISOString()}] Sample pair keys: ${Object.keys(samplePair).join(", ")}`);
      console.log(`[${new Date().toISOString()}] Sample pair: ${JSON.stringify(samplePair, null, 2)}`);
    }
    console.log(`[${new Date().toISOString()}] === END RAW RESPONSE ===`);
  }

  console.log(`[${new Date().toISOString()}] Discovery: ${rawPairs.length} deduplicated raw pairs from ${SEARCH_QUERIES.length} queries`);

  // Log key fields for first 5 raw pairs
  for (const p of rawPairs.slice(0, 5)) {
    console.log(`[${new Date().toISOString()}] RAW PAIR: dexId=${p.dexId} chainId=${p.chainId} liq=${p.liquidity?.usd} fdv=${p.fdv} vol24=${p.volume?.h24}`);
  }

  const now = Date.now();
  const filtered = rawPairs.filter((p) => {
    if (p.chainId !== "solana") return false;

    const dex = (p.dexId || "").toLowerCase();
    if (dex !== "pumpswap" && dex !== "pumpfun") return false;

    const liq = p.liquidity?.usd ?? 0;
    if (liq < 10000) return false;

    const fdv = p.fdv ?? 0;
    if (fdv < 30000) return false;

    const vol24 = p.volume?.h24 ?? 0;
    if (vol24 < 50000) return false;

    const createdAt = p.pairCreatedAt ?? 0;
    if (!createdAt) return false;
    const ageMs = now - createdAt;
    if (ageMs < MIN_AGE_MS || ageMs > MAX_AGE_MS) return false;

    return true;
  });

  console.log(`[${new Date().toISOString()}] Discovery: ${filtered.length} pairs after filtering`);

  return { pairs: filtered };
}

/**
 * Fetch live pair stats from official Dexscreener API in batches of 30
 */
export async function fetchPairStats(addresses) {
  if (!addresses.length) return [];

  const results = [];
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const joined = batch.join(",");
    const url = `https://api.dexscreener.com/latest/dex/pairs/solana/${joined}`;
    try {
      const data = await fetchWithRetry(url, dexLimiter);
      if (data && data.pairs) {
        results.push(...data.pairs);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] fetchPairStats batch error:`, err.message);
    }
  }
  return results;
}

/**
 * Fetch 5m OHLCV from GeckoTerminal for a single pool
 */
export async function fetchOHLCV(poolAddress) {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}/ohlcv/minute?aggregate=5&limit=100&currency=usd`;
  const data = await fetchWithRetry(url, geckoLimiter);
  return data;
}
