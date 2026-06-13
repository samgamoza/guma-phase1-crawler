/**
 * RateLimiter — token bucket.
 *
 * Ensures we never exceed REQUESTS_PER_MINUTE across all concurrent workers,
 * and enforces a minimum CRAWL_DELAY_MS between successive requests from a
 * single Playwright page context.
 */
export class RateLimiter {
  constructor({
    requestsPerMinute = 20,
    minDelayMs = 3000,
  } = {}) {
    this.rpm = requestsPerMinute
    this.minDelayMs = minDelayMs
    this.tokens = requestsPerMinute
    this.lastRefill = Date.now()
    this.lastRequest = 0
    this.queue = []
    this._draining = false
  }

  static fromEnv() {
    return new RateLimiter({
      requestsPerMinute: parseInt(process.env.REQUESTS_PER_MINUTE || '20', 10),
      minDelayMs: parseInt(process.env.CRAWL_DELAY_MS || '3000', 10),
    })
  }

  /** Call before each page.goto() — resolves when a token is available */
  async acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve)
      if (!this._draining) this._drain()
    })
  }

  _refill() {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000 / 60 // minutes
    const newTokens = elapsed * this.rpm
    this.tokens = Math.min(this.rpm, this.tokens + newTokens)
    this.lastRefill = now
  }

  async _drain() {
    this._draining = true
    while (this.queue.length > 0) {
      this._refill()
      if (this.tokens >= 1) {
        const sinceLastMs = Date.now() - this.lastRequest
        if (sinceLastMs < this.minDelayMs) {
          await sleep(this.minDelayMs - sinceLastMs)
        }
        this.tokens -= 1
        this.lastRequest = Date.now()
        this.queue.shift()()
      } else {
        // Wait until next token is available
        const waitMs = (1 / this.rpm) * 60 * 1000
        await sleep(waitMs)
      }
    }
    this._draining = false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
