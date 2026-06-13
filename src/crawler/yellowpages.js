import { chromium } from 'playwright'
import slugify from 'slugify'
import { logger } from '../utils/logger.js'

/**
 * YellowPagesScraper
 *
 * Two-phase scrape:
 *   1. Listing page  — collect business URLs from search results
 *   2. Detail page   — extract full business data from each URL
 *
 * Designed to be instantiated once per BullMQ worker process and reused
 * across jobs (shared browser, one context per job for isolation).
 */
export class YellowPagesScraper {
  constructor({ proxyManager, rateLimiter }) {
    this.proxyManager = proxyManager
    this.rateLimiter = rateLimiter
    this.browser = null
  }

  async init() {
    this.browser = await chromium.launch({
      headless: true,
      // Use the system Chromium when provided (Docker image installs it at
      // /usr/bin/chromium with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1). Falls back
      // to Playwright's bundled browser locally when CHROME_PATH is unset.
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
      ],
    })
    logger.info('Browser launched')
  }

  async close() {
    if (this.browser) {
      await this.browser.close()
      this.browser = null
      logger.info('Browser closed')
    }
  }

  /**
   * Main entry — scrape a full search (all pages) for a category + location.
   * Returns array of normalised business objects ready for DB upsert.
   */
  async scrapeSearch({ category, city, state, maxPages = 5 }) {
    const jobLabel = `${category} / ${city}, ${state}`
    logger.info(`Starting search scrape: ${jobLabel}`)

    const listingUrls = await this._collectListingUrls({ category, city, state, maxPages })
    logger.info(`Found ${listingUrls.length} listing URLs for ${jobLabel}`)

    const businesses = []
    for (const url of listingUrls) {
      try {
        const biz = await this._scrapeDetail(url)
        if (biz) businesses.push(biz)
      } catch (err) {
        logger.warn(`Detail scrape failed: ${url}`, { error: err.message })
      }
    }

    logger.info(`Scraped ${businesses.length} businesses for ${jobLabel}`)
    return businesses
  }

  // ─── Phase 1: collect URLs from search result pages ──────────────────────

  async _collectListingUrls({ category, city, state, maxPages }) {
    const urls = []
    const slug = `${category.toLowerCase().replace(/\s+/g, '-')}/${city.toLowerCase().replace(/\s+/g, '-')}-${state.toLowerCase()}`

    for (let page = 1; page <= maxPages; page++) {
      const searchUrl =
        page === 1
          ? `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(category)}&geo_location_terms=${encodeURIComponent(`${city}, ${state}`)}`
          : `https://www.yellowpages.com/search?search_terms=${encodeURIComponent(category)}&geo_location_terms=${encodeURIComponent(`${city}, ${state}`)}&page=${page}`

      const pageUrls = await this._withRetry(() => this._extractListingUrls(searchUrl), 3)
      if (!pageUrls || pageUrls.length === 0) {
        logger.info(`No results on page ${page} — stopping pagination`)
        break
      }

      urls.push(...pageUrls)
      logger.debug(`Page ${page}: found ${pageUrls.length} URLs`)
    }

    // Deduplicate
    return [...new Set(urls)]
  }

  async _extractListingUrls(searchUrl) {
    const context = await this._newContext()
    const pageObj = await context.newPage()

    try {
      await this.rateLimiter.acquire()
      await pageObj.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this._humanDelay()
      await this._handleCaptcha(pageObj)

      const urls = await pageObj.evaluate(() => {
        return Array.from(
          document.querySelectorAll('a.business-name, .result a.business-name, h2.n a')
        )
          .map((a) => a.href)
          .filter((h) => h.includes('yellowpages.com') && !h.includes('/search'))
      })

      return urls
    } finally {
      await context.close()
    }
  }

  // ─── Phase 2: scrape individual business detail page ─────────────────────

  async _scrapeDetail(url) {
    const context = await this._newContext()
    const pageObj = await context.newPage()

    try {
      await this.rateLimiter.acquire()
      await pageObj.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this._humanDelay()
      await this._handleCaptcha(pageObj)

      const raw = await pageObj.evaluate(() => {
        const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null
        const getAttr = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || null

        // Business name
        const name =
          getText('h1.business-name') ||
          getText('.dockable.business-name span') ||
          getText('h1')

        // Phone
        const phone =
          getText('.phone') ||
          getText('a[href^="tel:"]') ||
          getAttr('a[href^="tel:"]', 'href')?.replace('tel:', '')

        // Address components
        const street = getText('.street-address')
        const locality = getText('.locality')
        const city = getText('.city')
        const state = getText('.state')
        const zip = getText('.zip')
        const address = [street, locality || `${city || ''}, ${state || ''} ${zip || ''}`]
          .filter(Boolean)
          .join(', ')
          .replace(/\s+/g, ' ')
          .trim()

        // Category
        const category =
          getText('.categories a') ||
          getText('.bread-crumbs a:last-child') ||
          null

        // Description / about
        const description =
          getText('.from-the-business p') ||
          getText('.business-description') ||
          null

        // Website — check if they already have one
        const websiteEl = document.querySelector('a.weburl')
        const websiteUrl = websiteEl?.href || null
        const hasWebsite = !!websiteUrl && !websiteUrl.includes('yellowpages.com')

        // Hours
        const hoursRows = Array.from(document.querySelectorAll('.hours-row'))
        const hours = hoursRows
          .map((row) => {
            const day = row.querySelector('.day')?.textContent?.trim()
            const time = row.querySelector('.time')?.textContent?.trim()
            return day && time ? `${day}: ${time}` : null
          })
          .filter(Boolean)
          .join(', ')

        // Reviews
        const rating = getText('.result-rating em') || getText('.ratings em') || null
        const reviewCount =
          parseInt(
            (getText('.count') || getText('.review-count') || '').replace(/\D/g, ''),
            10
          ) || 0

        // Email (rare but sometimes present)
        const emailEl = document.querySelector('a[href^="mailto:"]')
        const email = emailEl?.href?.replace('mailto:', '') || null

        return {
          name,
          phone,
          address,
          city: city || locality?.split(',')[0]?.trim() || null,
          state,
          zip,
          category,
          description,
          has_website: hasWebsite,
          website_url: hasWebsite ? websiteUrl : null,
          hours,
          rating,
          review_count: reviewCount,
          email,
        }
      })

      if (!raw.name) {
        logger.warn(`No name found at ${url} — skipping`)
        return null
      }

      return this._normalise(raw, url)
    } finally {
      await context.close()
    }
  }

  // ─── Normalise raw data into DB schema ───────────────────────────────────

  _normalise(raw, sourceUrl) {
    const name = raw.name.replace(/\s+/g, ' ').trim()
    const slug = slugify(`${name}-${raw.city || ''}-${raw.state || ''}`, {
      lower: true,
      strict: true,
      trim: true,
    }).substring(0, 120)

    return {
      name,
      slug,
      category: raw.category,
      phone: raw.phone,
      email: raw.email,
      address: raw.address,
      city: raw.city,
      country: 'US',
      source_url: sourceUrl,
      source_dir: 'yellowpages',
      has_website: raw.has_website,
      raw_data: {
        state: raw.state,
        zip: raw.zip,
        description: raw.description,
        hours: raw.hours,
        rating: raw.rating,
        review_count: raw.review_count,
        website_url: raw.website_url,
      },
      crawled_at: new Date().toISOString(),
    }
  }

  // ─── Browser context with optional proxy ─────────────────────────────────

  async _newContext() {
    const proxyUrl = this.proxyManager.next()

    const contextOptions = {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      },
    }

    if (proxyUrl) {
      const parsed = new URL(proxyUrl)
      contextOptions.proxy = {
        server: `${parsed.protocol}//${parsed.hostname}:${parsed.port}`,
        username: parsed.username,
        password: parsed.password,
      }
    }

    return this.browser.newContext(contextOptions)
  }

  // ─── Human-like delay ─────────────────────────────────────────────────────

  async _humanDelay() {
    const ms = 800 + Math.random() * 1200
    await new Promise((r) => setTimeout(r, ms))
  }

  // ─── Captcha detection ────────────────────────────────────────────────────

  async _handleCaptcha(page) {
    const title = await page.title()
    const hasCaptcha =
      title.toLowerCase().includes('captcha') ||
      title.toLowerCase().includes('are you a robot') ||
      (await page.$('iframe[src*="captcha"]').catch(() => null))

    if (hasCaptcha) {
      logger.warn('CAPTCHA detected — pausing 60s then continuing')
      await new Promise((r) => setTimeout(r, 60_000))
      throw new Error('CAPTCHA_DETECTED')
    }
  }

  // ─── Retry wrapper ────────────────────────────────────────────────────────

  async _withRetry(fn, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        if (attempt === retries) throw err
        const wait = attempt * 5_000
        logger.warn(`Attempt ${attempt} failed: ${err.message} — retrying in ${wait}ms`)
        await new Promise((r) => setTimeout(r, wait))
      }
    }
  }
}
