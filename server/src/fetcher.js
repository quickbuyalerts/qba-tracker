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

/**
 * Discover pairs from Dexscreener.
 * Primary: io.dexscreener.com search endpoint (has filters).
 * Fallback: official token search API (broader results, client-side filter).
 */
export async function discoverPairs() {
  // Try the search endpoint first
  try {
    const url =
      "https://io.dexscreener.com/dex/search/pairs/solana?dexIds=pumpswap,pumpfun&minLiq=10000&minMarketCap=30000&minAge=48&maxAge=480&min24HVol=80000&max24HVol=180000&max6HVol=50000&profile=0&launchpads=1";
    const data = await fetchWithRetry(url, discoveryLimiter, 1);
    if (data && (data.pairs?.length || data.results?.length)) {
      return data;
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: use official Dexscreener token search for Solana memecoins
  console.log(`[${new Date().toISOString()}] Using fallback discovery via official API`);
  const searches = ["pumpfun solana", "pumpswap solana"];
  const allPairs = [];
  const seen = new Set();

  for (const query of searches) {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
      const data = await fetchWithRetry(url, discoveryLimiter, 2);
      if (data?.pairs) {
        for (const p of data.pairs) {
          if (p.chainId !== "solana") continue;
          if (seen.has(p.pairAddress)) continue;
          // Apply filters client-side
          const liq = p.liquidity?.usd ?? 0;
          const mcap = p.marketCap ?? p.fdv ?? 0;
          const vol24 = p.volume?.h24 ?? 0;
          const ageMin = p.pairCreatedAt
            ? (Date.now() - p.pairCreatedAt) / 60000
            : 0;
          const dex = p.dexId || "";
          if (
            (dex.includes("pump") || dex.includes("raydium")) &&
            liq >= 10000 &&
            mcap >= 30000 &&
            vol24 >= 80000 &&
            vol24 <= 180000 &&
            ageMin >= 48 &&
            ageMin <= 480
          ) {
            seen.add(p.pairAddress);
            allPairs.push(p);
          }
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Fallback search "${query}" error:`, err.message);
    }
  }

  return { pairs: allPairs };
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
