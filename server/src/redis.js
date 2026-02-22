import { Redis } from "@upstash/redis";

let redis = null;

export function getRedis() {
  if (!redis && process.env.UPSTASH_REDIS_URL && process.env.UPSTASH_REDIS_TOKEN) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_URL,
      token: process.env.UPSTASH_REDIS_TOKEN,
    });
  }
  return redis;
}

const PAIRS_KEY = "qba:pairs";
const ATH_KEY = "qba:ath";

export async function persistState(pairsMap) {
  const r = getRedis();
  if (!r) return;
  try {
    const serializable = {};
    for (const [addr, data] of pairsMap) {
      serializable[addr] = data;
    }
    await r.set(PAIRS_KEY, JSON.stringify(serializable));
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Redis persist error:`, err.message);
  }
}

export async function restoreState() {
  const r = getRedis();
  if (!r) return new Map();
  try {
    const raw = await r.get(PAIRS_KEY);
    if (!raw) return new Map();
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const map = new Map();
    for (const [addr, data] of Object.entries(parsed)) {
      map.set(addr, data);
    }
    console.log(`[${new Date().toISOString()}] Restored ${map.size} pairs from Redis`);
    return map;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Redis restore error:`, err.message);
    return new Map();
  }
}
