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

/**
 * Discover pairs via Dexscreener token-profiles + tokens lookup.
 * 1. Fetch latest token profiles to get recently active token addresses.
 * 2. Look up all pairs for those tokens in batches of 30.
 * 3. Filter for pumpswap/pumpfun Solana pairs matching criteria.
 */
export async function discoverPairs() {
  // Step 1: Get latest token profiles
  const profiles = await fetchWithRetry(
    "https://api.dexscreener.com/token-profiles/latest/v1",
    discoveryLimiter
  );

  // Extract unique Solana token addresses
  const tokenAddrs = new Set();
  const profileList = Array.isArray(profiles) ? profiles : profiles?.data || [];
  for (const p of profileList) {
    if (p.chainId === "solana" && p.tokenAddress) {
      tokenAddrs.add(p.tokenAddress);
    }
  }

  if (isFirstDiscovery) {
    isFirstDiscovery = false;
    const sample = profileList[0];
    console.log(`[${new Date().toISOString()}] === FIRST PROFILE RESPONSE ===`);
    console.log(`[${new Date().toISOString()}] Profile array length: ${profileList.length}`);
    if (sample) {
      console.log(`[${new Date().toISOString()}] Sample profile keys: ${Object.keys(sample).join(", ")}`);
      console.log(`[${new Date().toISOString()}] Sample profile: ${JSON.stringify(sample, null, 2)}`);
    }
    console.log(`[${new Date().toISOString()}] === END PROFILE RESPONSE ===`);
  }

  console.log(`[${new Date().toISOString()}] Discovery: ${profileList.length} profiles, ${tokenAddrs.size} unique Solana token addresses`);

  // Step 2: Fetch pairs for tokens in batches of 30
  const addrs = Array.from(tokenAddrs);
  const rawPairs = [];
  const seenPairs = new Set();

  for (let i = 0; i < addrs.length; i += 30) {
    const batch = addrs.slice(i, i + 30).join(",");
    try {
      const data = await fetchWithRetry(
        `https://api.dexscreener.com/latest/dex/tokens/${batch}`,
        dexLimiter
      );
      if (data?.pairs) {
        for (const p of data.pairs) {
          if (!seenPairs.has(p.pairAddress)) {
            seenPairs.add(p.pairAddress);
            rawPairs.push(p);
          }
        }
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Token batch error:`, err.message);
    }
  }

  console.log(`[${new Date().toISOString()}] Discovery: ${rawPairs.length} raw pairs from token lookups`);

  // Log key fields for first 5 raw pairs
  for (const p of rawPairs.slice(0, 5)) {
    console.log(`[${new Date().toISOString()}] RAW PAIR: dexId=${p.dexId} chainId=${p.chainId} liq=${p.liquidity?.usd} fdv=${p.fdv} vol24=${p.volume?.h24}`);
  }

  // Step 3: Filter
  const now = Date.now();
  const MIN_AGE_MS = 2 * 3600_000;    // 2 hours
  const MAX_AGE_MS = 1000 * 3600_000;  // 1000 hours

  const filtered = rawPairs.filter((p) => {
    if (p.chainId !== "solana") return false;

    const dex = (p.dexId || "").toLowerCase();
    if (dex !== "pumpswap" && dex !== "pumpfun") return false;

    const liq = p.liquidity?.usd;
    if (liq != null && liq < 10000) return false;

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
