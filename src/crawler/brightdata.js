/**
 * BrightDataScraper
 *
 * Two modes — set BRIGHT_DATA_MODE in env to choose:
 *
 * Mode 1: "dataset" (default)
 *   Triggers a Bright Data Dataset API collection job.
 *   Best for large scheduled runs. Bright Data crawls async, you poll for results.
 *   Dataset IDs: Google Maps → gd_l7q7dkf244hwjntr0 (community)
 *   Docs: https://docs.brightdata.com/scraping-automation/web-data-apis/web-scraper-api/overview
 *
 * Mode 2: "proxy"
 *   Routes the existing YellowPages Playwright scraper through Bright Data's
 *   residential proxy network instead of your own proxies.
 *   Useful when bot detection blocks direct/shared proxies.
 *   Docs: https://docs.brightdata.com/proxy-networks/residential-proxies
 *
 * Required env:
 *   BRIGHT_DATA_API_TOKEN   — from https://brightdata.com/cp/setting
 *   BRIGHT_DATA_MODE        — 'dataset' | 'proxy' (default: 'dataset')
 *
 * Dataset mode only:
 *   BRIGHT_DATA_DATASET_ID  — default: gd_l7q7dkf244hwjntr0 (Google Maps)
 *   BRIGHT_DATA_TIMEOUT_SECS— max wait (default: 600)
 *
 * Proxy mode only:
 *   BRIGHT_DATA_PROXY_HOST  — e.g. brd.superproxy.io
 *   BRIGHT_DATA_PROXY_PORT  — e.g. 22225
 *   BRIGHT_DATA_PROXY_USER  — e.g. brd-customer-XXXXX-zone-residential
 *   BRIGHT_DATA_PROXY_PASS  — your zone password
 */

import slugify from 'slugify'
import { logger } from '../utils/logger.js'

const BD_BASE           = 'https://api.brightdata.com'
const DEFAULT_DATASET   = 'gd_l7q7dkf244hwjntr0'  // Bright Data Google Maps dataset
const POLL_INTERVAL     = 8_000

export class BrightDataScraper {
  constructor() {
    this.token   = process.env.BRIGHT_DATA_API_TOKEN
    this.mode    = process.env.BRIGHT_DATA_MODE || 'dataset'

    if (!this.token) throw new Error('Missing BRIGHT_DATA_API_TOKEN')

    if (this.mode === 'dataset') {
      this.datasetId  = process.env.BRIGHT_DATA_DATASET_ID || DEFAULT_DATASET
      this.timeoutMs  = parseInt(process.env.BRIGHT_DATA_TIMEOUT_SECS || '600', 10) * 1000
      logger.info(`[BrightData] Dataset mode — dataset: ${this.datasetId}`)
    } else if (this.mode === 'proxy') {
      this.proxyHost = process.env.BRIGHT_DATA_PROXY_HOST
      this.proxyPort = process.env.BRIGHT_DATA_PROXY_PORT
      this.proxyUser = process.env.BRIGHT_DATA_PROXY_USER
      this.proxyPass = process.env.BRIGHT_DATA_PROXY_PASS
      if (!this.proxyHost || !this.proxyPort || !this.proxyUser || !this.proxyPass) {
        throw new Error('Bright Data proxy mode requires BRIGHT_DATA_PROXY_HOST/PORT/USER/PASS')
      }
      logger.info(`[BrightData] Proxy mode — ${this.proxyHost}:${this.proxyPort}`)
    } else {
      throw new Error(`Unknown BRIGHT_DATA_MODE: ${this.mode}. Use 'dataset' or 'proxy'.`)
    }
  }

  /**
   * Main entry — mirrors all other scraper signatures.
   */
  async scrapeSearch({ category, city, state, maxPages = 5 }) {
    if (this.mode === 'dataset') {
      return this._scrapeViaDataset({ category, city, state, maxPages })
    }
    // proxy mode: return proxy config for caller to pass to YellowPagesScraper
    // This mode doesn't directly return businesses — see getProxyConfig()
    throw new Error(
      'BrightData proxy mode does not implement scrapeSearch directly. ' +
      'Call getProxyConfig() and pass the result to YellowPagesScraper.'
    )
  }

  // ─── Dataset mode ─────────────────────────────────────────────────────────

  async _scrapeViaDataset({ category, city, state, maxPages }) {
    const label = `${category} / ${city}, ${state}`
    logger.info(`[BrightData] Triggering dataset collection: ${label}`)

    const snapshotId = await this._triggerCollection({ category, city, state, maxPages })
    logger.info(`[BrightData] Snapshot ID: ${snapshotId}`)

    const items = await this._waitForSnapshot(snapshotId)
    logger.info(`[BrightData] Fetched ${items.length} items for ${label}`)

    const businesses = items.map((i) => this._normalise(i, city, state)).filter(Boolean)
    logger.info(`[BrightData] Returning ${businesses.length} businesses for ${label}`)
    return businesses
  }

  async _triggerCollection({ category, city, state, maxPages }) {
    const url = `${BD_BASE}/datasets/v3/trigger?dataset_id=${this.datasetId}&include_errors=true`

    // Input format for Bright Data Google Maps dataset
    const inputs = [{
      keyword:  `${category} in ${city}, ${state}`,
      location: `${city}, ${state}, United States`,
      max_results: maxPages * 20,
    }]

    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(inputs),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`BrightData trigger failed (${res.status}): ${text.slice(0, 300)}`)
    }

    const data = await res.json()
    return data.snapshot_id
  }

  async _waitForSnapshot(snapshotId) {
    const deadline = Date.now() + this.timeoutMs
    const statusUrl = `${BD_BASE}/datasets/v3/snapshots/${snapshotId}`

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))

      const res  = await fetch(statusUrl, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      })
      const data = await res.json()

      logger.debug(`[BrightData] Snapshot ${snapshotId} status: ${data.status}`)

      if (data.status === 'ready') {
        return this._downloadSnapshot(snapshotId)
      }
      if (data.status === 'failed') {
        throw new Error(`BrightData snapshot ${snapshotId} failed`)
      }
    }

    throw new Error(`BrightData snapshot ${snapshotId} timed out after ${this.timeoutMs / 1000}s`)
  }

  async _downloadSnapshot(snapshotId) {
    const url = `${BD_BASE}/datasets/v3/snapshots/${snapshotId}/download?format=json`
    const res  = await fetch(url, {
      headers: { 'Authorization': `Bearer ${this.token}` },
    })
    if (!res.ok) throw new Error(`BrightData download failed (${res.status})`)
    return res.json()
  }

  // ─── Proxy mode ───────────────────────────────────────────────────────────

  /**
   * Returns a proxy URL string compatible with YellowPagesScraper / ProxyManager.
   * Usage:
   *   const bd = new BrightDataScraper()
   *   process.env.PROXY_LIST = bd.getProxyUrl()
   *   const scraper = new YellowPagesScraper({ proxyManager: ProxyManager.fromEnv(), ... })
   */
  getProxyUrl() {
    if (this.mode !== 'proxy') throw new Error('getProxyUrl() only available in proxy mode')
    return `http://${this.proxyUser}:${this.proxyPass}@${this.proxyHost}:${this.proxyPort}`
  }

  // ─── Normalise Bright Data Google Maps output to DB schema ───────────────

  _normalise(item, fallbackCity, fallbackState) {
    // Bright Data Google Maps dataset fields:
    // name, full_address, phone, site, rating, reviews, category, city, state,
    // zip_code, description, permanently_closed, google_id, latitude, longitude
    const name = item.name?.trim()
    if (!name) return null
    if (item.permanently_closed) return null

    const city  = item.city  || fallbackCity
    const state = item.state || fallbackState
    const hasWebsite = Boolean(item.site)

    const slug = slugify(`${name}-${city}-${state}`, {
      lower: true, strict: true, trim: true,
    }).substring(0, 120)

    return {
      name,
      slug,
      category:    item.category || 'Local Business',
      phone:       item.phone || null,
      email:       null,
      address:     item.full_address || null,
      city,
      country:     'US',
      source_url:  item.google_id
        ? `https://maps.google.com/?cid=${item.google_id}`
        : null,
      source_dir:  'brightdata',
      has_website: hasWebsite,
      raw_data: {
        state,
        zip:          item.zip_code || null,
        description:  item.description || null,
        rating:       item.rating?.toString() || null,
        review_count: item.reviews || 0,
        website_url:  item.site || null,
        google_id:    item.google_id || null,
        latitude:     item.latitude || null,
        longitude:    item.longitude || null,
      },
      crawled_at: new Date().toISOString(),
    }
  }
}
