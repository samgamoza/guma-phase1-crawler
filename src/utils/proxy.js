import { logger } from './logger.js'

/**
 * ProxyManager — round-robin rotation with per-proxy failure tracking.
 *
 * Proxies are read from the PROXY_LIST env var as a comma-separated list of
 * full proxy URLs:  http://user:pass@host:port
 *
 * A proxy is temporarily banned after MAX_FAILURES consecutive errors and
 * re-enabled after BAN_DURATION_MS.
 */

const MAX_FAILURES = 3
const BAN_DURATION_MS = 5 * 60 * 1000 // 5 minutes

export class ProxyManager {
  constructor(proxyUrls = []) {
    this.proxies = proxyUrls.map((url) => ({
      url,
      failures: 0,
      bannedUntil: null,
      uses: 0,
    }))
    this.index = 0

    if (this.proxies.length === 0) {
      logger.warn('ProxyManager: no proxies configured — running without proxy (risk of blocks)')
    } else {
      logger.info(`ProxyManager: loaded ${this.proxies.length} proxies`)
    }
  }

  static fromEnv() {
    const raw = process.env.PROXY_LIST || ''
    const urls = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    return new ProxyManager(urls)
  }

  /** Return the next healthy proxy, or null if none available */
  next() {
    if (this.proxies.length === 0) return null

    const now = Date.now()
    let attempts = 0

    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.index % this.proxies.length]
      this.index++
      attempts++

      // Re-enable if ban has expired
      if (proxy.bannedUntil && now > proxy.bannedUntil) {
        proxy.bannedUntil = null
        proxy.failures = 0
        logger.debug(`Proxy re-enabled: ${this._mask(proxy.url)}`)
      }

      if (!proxy.bannedUntil) {
        proxy.uses++
        return proxy.url
      }
    }

    logger.warn('All proxies currently banned — retrying without proxy')
    return null
  }

  /** Mark a proxy as failed; ban it after MAX_FAILURES */
  reportFailure(proxyUrl) {
    const proxy = this.proxies.find((p) => p.url === proxyUrl)
    if (!proxy) return

    proxy.failures++
    if (proxy.failures >= MAX_FAILURES) {
      proxy.bannedUntil = Date.now() + BAN_DURATION_MS
      logger.warn(`Proxy banned (${proxy.failures} failures): ${this._mask(proxyUrl)}`)
    }
  }

  reportSuccess(proxyUrl) {
    const proxy = this.proxies.find((p) => p.url === proxyUrl)
    if (proxy) proxy.failures = 0
  }

  stats() {
    return this.proxies.map((p) => ({
      url: this._mask(p.url),
      uses: p.uses,
      failures: p.failures,
      banned: !!p.bannedUntil,
    }))
  }

  _mask(url) {
    return url.replace(/:\/\/[^@]+@/, '://**:**@')
  }
}
