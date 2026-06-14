/**
 * ApifyScraper
 *
 * Delegates crawl jobs to Apify cloud actors.
 * No local browser or proxy setup needed — Apify handles infrastructure.
 *
 * Default actor: apify/google-maps-scraper
 * Alternatives:  apify/yellow-pages-scraper, apify/yelp-scraper
 *
 * Pricing: pay-per-result (~$0.004–0.01/record depending on actor)
 * Docs: https://docs.apify.com/api/v2
 *
 * Required env:
 *   APIFY_API_TOKEN      — from https://console.apify.com/account/integrations
 *   APIFY_ACTOR_ID       — default: apify~google-maps-scraper
 *   APIFY_TIMEOUT_SECS   — max wait for run to finish (default: 300)
 */

import slugify from 'slugify'
import { logger } from '../utils/logger.js'

const APIFY_BASE     = 'https://api.apify.com/v2'
const DEFAULT_ACTOR  = 'apify~google-maps-scraper'
const POLL_INTERVAL  = 5_000  // ms between run-status checks

export class ApifyScraper {
  constructor() {
    this.token      = process.env.APIFY_API_TOKEN
    this.actorId    = process.env.APIFY_ACTOR_ID || DEFAULT_ACTOR
    this.timeoutMs  = parseInt(process.env.APIFY_TIMEOUT_SECS || '300', 10) * 1000

    if (!this.token) throw new Error('Missing APIFY_API_TOKEN')
  }

  /**
   * Main entry — mirrors all other scraper signatures.
   * Runs the Apify actor synchronously (polls until done).
   */
  async scrapeSearch({ category, city, state, maxPages = 5 }) {
    const label = `${category} / ${city}, ${state}`
    logger.info(`[Apify] Starting actor run: ${label}`)

    const input = this._buildInput({ category, city, state, maxPages })
    const runId = await this._startRun(input)
    logger.info(`[Apify] Run started: ${runId}`)

    const dataset = await this._waitForRun(runId)
    const items   = await this._fetchDataset(dataset)
    logger.info(`[Apify] Fetched ${items.length} items for ${label}`)

    const businesses = items
      .map((item) => this._normalise(item, city, state))
      .filter(Boolean)

    logger.info(`[Apify] Returning ${businesses.length} businesses for ${label}`)
    return businesses
  }

  // ─── Build actor input ────────────────────────────────────────────────────

  _buildInput({ category, city, state, maxPages }) {
    // Input schema for apify/google-maps-scraper
    // Swap this object when using a different actor.
    return {
      searchStringsArray: [`${category} in ${city}, ${state}`],
      maxCrawledPlacesPerSearch: maxPages * 20,
      language: 'en',
      countryCode: 'us',
      includeWebResults: false,
      skipClosedPlaces: true,
    }
  }

  // ─── Start actor run ──────────────────────────────────────────────────────

  async _startRun(input) {
    const url = `${APIFY_BASE}/acts/${this.actorId}/runs?token=${this.token}`
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(input),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Apify start run failed (${res.status}): ${text.slice(0, 300)}`)
    }

    const data = await res.json()
    return data.data.id
  }

  // ─── Poll until run finishes ──────────────────────────────────────────────

  async _waitForRun(runId) {
    const deadline = Date.now() + this.timeoutMs
    const url = `${APIFY_BASE}/actor-runs/${runId}?token=${this.token}`

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))

      const res  = await fetch(url)
      const data = await res.json()
      const run  = data.data

      logger.debug(`[Apify] Run ${runId} status: ${run.status}`)

      if (run.status === 'SUCCEEDED') return run.defaultDatasetId
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(run.status)) {
        throw new Error(`Apify run ${runId} ended with status: ${run.status}`)
      }
    }

    throw new Error(`Apify run ${runId} timed out after ${this.timeoutMs / 1000}s`)
  }

  // ─── Fetch dataset items ──────────────────────────────────────────────────

  async _fetchDataset(datasetId) {
    const url = `${APIFY_BASE}/datasets/${datasetId}/items?token=${this.token}&format=json&clean=true`
    const res  = await fetch(url)

    if (!res.ok) throw new Error(`Apify dataset fetch failed (${res.status})`)
    return res.json()
  }

  // ─── Normalise Apify google-maps-scraper output to DB schema ─────────────

  _normalise(item, fallbackCity, fallbackState) {
    const name = item.title?.trim() || item.name?.trim()
    if (!name) return null

    // apify/google-maps-scraper fields:
    // title, address, phone, website, totalScore, reviewsCount, categoryName,
    // city, state, postalCode, description, permanently_closed, url (maps url)
    if (item.permanently_closed || item.temporarilyClosed) return null

    const city  = item.city  || fallbackCity
    const state = item.state || fallbackState
    const hasWebsite = Boolean(item.website)

    const slug = slugify(`${name}-${city}-${state}`, {
      lower: true, strict: true, trim: true,
    }).substring(0, 120)

    return {
      name,
      slug,
      category:    item.categoryName || 'Local Business',
      phone:       item.phone || null,
      email:       null,
      address:     item.address || null,
      city,
      country:     'US',
      source_url:  item.url || null,
      source_dir:  'apify',
      has_website: hasWebsite,
      raw_data: {
        state,
        zip:          item.postalCode || null,
        description:  item.description || null,
        rating:       item.totalScore?.toString() || null,
        review_count: item.reviewsCount || 0,
        website_url:  item.website || null,
        place_id:     item.placeId || null,
        actor_id:     this.actorId,
      },
      crawled_at: new Date().toISOString(),
    }
  }
}
