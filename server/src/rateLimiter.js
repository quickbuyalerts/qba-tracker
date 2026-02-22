export class TokenBucketLimiter {
  constructor(maxTokens, refillRate) {
    this.maxTokens = maxTokens;
    this.tokens = maxTokens;
    this.refillRate = refillRate; // tokens per second
    this.lastRefill = Date.now();
  }

  async acquire() {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    const waitMs = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
    this._refill();
    this.tokens -= 1;
    return true;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// Dexscreener: generous bucket
export const dexLimiter = new TokenBucketLimiter(10, 2);
// GeckoTerminal: stricter (30 req/min free tier)
export const geckoLimiter = new TokenBucketLimiter(5, 0.5);
// Discovery endpoint
export const discoveryLimiter = new TokenBucketLimiter(3, 0.1);
