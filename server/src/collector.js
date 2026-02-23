import puppeteer from "puppeteer";
import { computeRSI } from "./rsi.js";
import { persistState, clearPairs } from "./redis.js";

const DEXSCREENER_PAGE =
  "https://dexscreener.com/?rankBy=trendingScoreH6&order=desc&chainIds=solana&dexIds=pumpswap,pumpfun&minLiq=10000&minMarketCap=30000&minAge=2&maxAge=1000&min24HVol=80000&max24HVol=180000&profile=0&launchpads=1";

const GECKO_OHLCV = (addr) =>
  `https://api.geckoterminal.com/api/v2/networks/solana/pools/${addr}/ohlcv/minute?aggregate=5&limit=100&currency=usd`;

let pairs = new Map();
let collectorStatus = "starting";
let lastDiscovery = null;
let lastOhlcvUpdate = null;

// --- SSE ---
const sseClients = new Set();
export function registerSSEClient(c) { sseClients.add(c); }
export function removeSSEClient(c) { sseClients.delete(c); }

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch { sseClients.delete(c); }
  }
}

export function getSnapshot() {
  return { pairs: Object.fromEntries(pairs), stats: getStats() };
}

export function getStats() {
  const all = Array.from(pairs.values());
  const rsi = all.map((p) => p.rsi5m).filter((v) => v != null);
  return {
    totalPairs: pairs.size,
    overbought: rsi.filter((r) => r > 70).length,
    oversold: rsi.filter((r) => r < 30).length,
    avgRsi: rsi.length ? +(rsi.reduce((a, b) => a + b, 0) / rsi.length).toFixed(1) : null,
    collectorStatus,
    lastDiscovery,
    lastOhlcvUpdate,
  };
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// --- Discovery: scrape Dexscreener with Puppeteer, then fetch pair data ---
async function scrapePairAddresses() {
  let browser;
  try {
    log("Puppeteer: launching browser...");
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    log("Puppeteer: navigating to Dexscreener...");
    await page.goto(DEXSCREENER_PAGE, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait for pair rows to render
    await page.waitForSelector("a[href*='/solana/']", { timeout: 15000 });

    // Extract pair addresses from links
    const addresses = await page.evaluate(() => {
      const links = document.querySelectorAll("a[href*='/solana/']");
      const addrs = new Set();
      for (const link of links) {
        const match = link.href.match(/\/solana\/([A-Za-z0-9]{20,})/);
        if (match) addrs.add(match[1]);
      }
      return Array.from(addrs);
    });

    log(`Puppeteer: extracted ${addresses.length} pair addresses`);
    return addresses;
  } catch (err) {
    log(`Puppeteer error: ${err.message}`);
    return [];
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function fetchPairData(addresses) {
  const results = [];
  // Batch in groups of 30
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30).join(",");
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${batch}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.pairs) results.push(...data.pairs);
    } catch (err) {
      log(`Pair fetch error: ${err.message}`);
    }
  }
  return results;
}

async function runDiscovery() {
  try {
    const addresses = await scrapePairAddresses();
    if (!addresses.length) {
      log(`Discovery: no addresses scraped, keeping existing ${pairs.size}`);
      return;
    }

    const rawPairs = await fetchPairData(addresses);
    log(`Discovery: ${addresses.length} addresses scraped, ${rawPairs.length} pairs fetched from API`);

    if (!rawPairs.length) {
      log(`Discovery: API returned 0 pairs, keeping existing`);
      return;
    }

    const newAddrs = new Set();
    for (const raw of rawPairs) {
      const addr = raw.pairAddress;
      if (!addr) continue;
      newAddrs.add(addr);

      if (!pairs.has(addr)) {
        pairs.set(addr, {
          pairAddress: addr,
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
          rsi5m: null,
          rsi15m: null,
          ath: null,
          candles5m: [],
          updatedAt: Date.now(),
        });
      } else {
        const existing = pairs.get(addr);
        existing.priceUsd = raw.priceUsd ? parseFloat(raw.priceUsd) : existing.priceUsd;
        existing.marketCap = raw.marketCap ?? raw.fdv ?? existing.marketCap;
        existing.liquidity = raw.liquidity?.usd ?? existing.liquidity;
        existing.volume24h = raw.volume?.h24 ?? existing.volume24h;
        existing.priceChange24h = raw.priceChange?.h24 ?? existing.priceChange24h;
        existing.imageUrl = raw.info?.imageUrl ?? existing.imageUrl;
        existing.updatedAt = Date.now();
      }
    }

    // Remove pairs no longer on the page
    for (const addr of pairs.keys()) {
      if (!newAddrs.has(addr)) pairs.delete(addr);
    }

    lastDiscovery = Date.now();
    collectorStatus = "running";
    log(`Discovery: tracking ${pairs.size} pairs`);
    broadcast("update", { pairs: Array.from(pairs.values()), stats: getStats() });
  } catch (err) {
    log(`Discovery error: ${err.message}`);
  }
}

// --- OHLCV + RSI ---
async function runOhlcvUpdate() {
  const addrs = Array.from(pairs.keys());
  if (!addrs.length) return;

  let updated = 0;
  for (const addr of addrs) {
    try {
      const res = await fetch(GECKO_OHLCV(addr), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          log(`GeckoTerminal 429, waiting 30s`);
          await new Promise((r) => setTimeout(r, 30000));
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const ohlcvList = data?.data?.attributes?.ohlcv_list || [];
      if (!ohlcvList.length) { await stagger(); continue; }

      const candles = ohlcvList.slice().reverse().map((c) => ({
        t: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5],
      }));

      const p = pairs.get(addr);
      if (!p) { await stagger(); continue; }

      p.candles5m = candles;
      p.rsi5m = computeRSI(candles.map((c) => c.c), 14);
      p.rsi15m = computeRSI(aggregate15m(candles), 14);

      const maxH = Math.max(...candles.map((c) => c.h));
      if (p.ath == null || maxH > p.ath) p.ath = maxH;
      if (p.priceUsd && p.priceUsd > p.ath) p.ath = p.priceUsd;

      updated++;
    } catch (err) {
      log(`OHLCV error ${addr.slice(0, 8)}...: ${err.message}`);
    }
    await stagger();
  }

  lastOhlcvUpdate = Date.now();
  if (updated) broadcast("update", { pairs: Array.from(pairs.values()), stats: getStats() });
  log(`OHLCV: updated ${updated}/${addrs.length} pairs`);
}

function stagger() { return new Promise((r) => setTimeout(r, 10000)); }

function aggregate15m(candles) {
  const closes = [];
  for (let i = 2; i < candles.length; i += 3) closes.push(candles[i].c);
  return closes;
}

// --- Persistence ---
async function runPersist() {
  try {
    await persistState(pairs);
    log(`Persisted ${pairs.size} pairs to Redis`);
  } catch (err) {
    log(`Persist error: ${err.message}`);
  }
}

// --- Start ---
export async function startCollector() {
  log("Starting collector...");
  await clearPairs();
  await runDiscovery();

  setInterval(runDiscovery, 60_000);
  setInterval(runOhlcvUpdate, 60_000);
  setInterval(runPersist, 60_000);
  setTimeout(runOhlcvUpdate, 5_000);

  collectorStatus = "running";
  log(`Collector running with ${pairs.size} pairs`);
}
