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
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Referer: "https://dexscreener.com/",
          Origin: "https://dexscreener.com",
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

const DISCOVERY_ENDPOINTS = [
  {
    name: "io-internal",
    url: "https://io.dexscreener.com/dex/search/pairs/solana?rankBy=trendingScoreH6&order=desc&dexIds=pumpswap,pumpfun&minLiq=10000&minMarketCap=30000&minAge=2&maxAge=1000&min24HVol=80000&max24HVol=180000&profile=0&launchpads=1",
    extract: (data) => data?.pairs || data?.results || [],
  },
  {
    name: "io-page-api",
    url: "https://io.dexscreener.com/dex/search/pairs/solana?dexIds=pumpswap,pumpfun&minLiq=10000&minMarketCap=30000&minAge=2&maxAge=1000&min24HVol=80000&max24HVol=180000",
    extract: (data) => data?.pairs || data?.results || [],
  },
  {
    name: "official-search-combined",
    url: null, // special: runs multiple searches
    extract: null,
  },
];

/**
 * Discover pairs by trying multiple Dexscreener endpoints in order.
 * io.dexscreener.com endpoints do server-side filtering.
 * Official search API fallback uses multiple queries + dedup.
 */
export async function discoverPairs() {
  for (const endpoint of DISCOVERY_ENDPOINTS) {
    try {
      console.log(`[${new Date().toISOString()}] Discovery: trying ${endpoint.name}...`);

      // Special handling for combined official search fallback
      if (endpoint.name === "official-search-combined") {
        const result = await discoverViaOfficialSearch();
        if (result.length > 0) return { pairs: result };
        continue;
      }

      const data = await fetchWithRetry(endpoint.url, discoveryLimiter, 1);

      const pairs = endpoint.extract(data);
      // Only keep Solana pairs with a valid pairAddress
      const valid = pairs.filter((p) => p.pairAddress && (p.chainId === "solana" || !p.chainId));

      console.log(`[${new Date().toISOString()}] Discovery: ${endpoint.name} returned ${pairs.length} total, ${valid.length} solana pairs`);

      // Log first 3 pairs
      for (const p of valid.slice(0, 3)) {
        console.log(`[${new Date().toISOString()}]   ${p.baseToken?.symbol || "?"} | dex=${p.dexId} liq=${p.liquidity?.usd} fdv=${p.fdv} vol24=${p.volume?.h24} addr=${p.pairAddress?.slice(0, 8)}...`);
      }

      if (valid.length > 0) {
        console.log(`[${new Date().toISOString()}] Discovery: using ${endpoint.name} (${valid.length} pairs)`);
        return { pairs: valid };
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Discovery: ${endpoint.name} failed: ${err.message}`);
    }
  }

  console.log(`[${new Date().toISOString()}] Discovery: all endpoints failed, returning empty`);
  return { pairs: [] };
}

const SEARCH_QUERIES = ["pump", "pumpswap", "pumpfun", "sol meme", "doge", "pepe", "cat", "dog", "ai", "trump"];

/**
 * Fallback: search official API with multiple queries, deduplicate,
 * then keep only pumpswap/pumpfun Solana pairs.
 */
async function discoverViaOfficialSearch() {
  const results = await Promise.allSettled(
    SEARCH_QUERIES.map((q) =>
      fetchWithRetry(
        `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
        discoveryLimiter
      )
    )
  );

  const seen = new Set();
  const allPairs = [];
  for (const r of results) {
    if (r.status !== "fulfilled" || !r.value?.pairs) continue;
    for (const p of r.value.pairs) {
      if (!p.pairAddress || seen.has(p.pairAddress)) continue;
      if (p.chainId !== "solana") continue;
      const dex = (p.dexId || "").toLowerCase();
      if (dex !== "pumpswap" && dex !== "pumpfun") continue;
      seen.add(p.pairAddress);
      allPairs.push(p);
    }
  }

  console.log(`[${new Date().toISOString()}] Discovery: official-search-combined found ${allPairs.length} pumpswap/pumpfun solana pairs from ${SEARCH_QUERIES.length} queries`);

  for (const p of allPairs.slice(0, 3)) {
    console.log(`[${new Date().toISOString()}]   ${p.baseToken?.symbol || "?"} | dex=${p.dexId} liq=${p.liquidity?.usd} fdv=${p.fdv} vol24=${p.volume?.h24} addr=${p.pairAddress?.slice(0, 8)}...`);
  }

  return allPairs;
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
