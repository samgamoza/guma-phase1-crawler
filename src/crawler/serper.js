/**
 * SerperScraper
 *
 * Uses Serper.dev Google Maps API to find local businesses.
 * Returns the Google local pack results (~10 per query).
 *
 * To maximise results for a city, the scraper runs multiple
 * neighbourhood/area sub-queries automatically and deduplicates.
 *
 * API docs: https://serper.dev/
 * Required env: SERPER_API_KEY
 * Cost: ~$0.001 per search (50 results per credit at scale)
 */

import slugify from 'slugify'
import { logger } from '../utils/logger.js'

const SERPER_URL = 'https://google.serper.dev/maps'

// Sub-area suffixes to broaden results beyond the top-10 local pack.
// Each suffix becomes a separate query: "Restaurants downtown Dallas TX" etc.
const AREA_SUFFIXES = [
  '',
  'downtown',
  'north',
  'south',
  'east side',
  'west side',
  'midtown',
  'uptown',
  'near me',
]

export class SerperScraper {
  constructor() {
    this.apiKey = process.env.SERPER_API_KEY
    if (!this.apiKey) throw new Error('Missing SERPER_API_KEY')
  }

  /**
   * Main entry — mirrors YellowPagesScraper.scrapeSearch() signature.
   * maxPages maps to number of sub-area queries (each returns ~10 results).
   */
  async scrapeSearch({ category, city, state, maxPages = 5 }) {
    const label = `${category} / ${city}, ${state}`
    logger.info(`[Serper] Starting search: ${label}`)

    const suffixes = AREA_SUFFIXES.slice(0, Math.max(1, maxPages))
    const seen = new Set()
    const businesses = []

    for (const suffix of suffixes) {
      const query = suffix
        ? `${category} ${suffix} ${city} ${state}`
        : `${category} ${city} ${state}`

      try {
        const results = await this._search(query)
        for (const r of results) {
          const key = r.cid || r.title + r.address
          if (seen.has(key)) continue
          seen.add(key)

          const biz = this._normalise(r, city, state)
          if (biz) businesses.push(biz)
        }
        logger.debug(`[Serper] "${query}" → ${results.length} results`)
      } catch (err) {
        logger.warn(`[Serper] Query failed: "${query}"`, { error: err.message })
      }

      // Polite delay between sub-queries
      if (suffixes.indexOf(suffix) < suffixes.length - 1) {
        await new Promise((r) => setTimeout(r, 500))
      }
    }

    logger.info(`[Serper] Returning ${businesses.length} unique businesses for ${label}`)
    return businesses
  }

  // ─── Single Serper /maps request ─────────────────────────────────────────

  async _search(query) {
    const res = await fetch(SERPER_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'us', hl: 'en' }),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`Serper HTTP ${res.status}: ${text.slice(0, 200)}`)
    }

    const data = await res.json()
    return data.places || []
  }

  // ─── Normalise Serper place to DB schema ─────────────────────────────────

  _normalise(place, fallbackCity, fallbackState) {
    const name = place.title?.trim()
    if (!name) return null

    // Serper returns address as a single string e.g. "123 Main St, Dallas, TX 75201"
    const address = place.address || null
    const { city, state } = this._parseAddress(address, fallbackCity, fallbackState)

    const hasWebsite = Boolean(place.website)

    const slug = slugify(`${name}-${city}-${state}`, {
      lower: true,
      strict: true,
      trim: true,
    }).substring(0, 120)

    return {
      name,
      slug,
      category:    this._resolveCategory(place.category || ''),
      phone:       place.phoneNumber || null,
      email:       null, // Serper does not return email
      address,
      city,
      country:     'US',
      source_url:  place.website || place.cid
        ? `https://maps.google.com/?cid=${place.cid}`
        : null,
      source_dir:  'serper',
      has_website: hasWebsite,
      raw_data: {
        state,
        description:  place.description || null,
        rating:       place.rating?.toString() || null,
        review_count: place.ratingCount || 0,
        website_url:  place.website || null,
        cid:          place.cid || null,
        category_raw: place.category || null,
      },
      crawled_at: new Date().toISOString(),
    }
  }

  // ─── Parse "123 Main St, Dallas, TX 75201" → { city, state } ────────────

  _parseAddress(address, fallbackCity, fallbackState) {
    if (!address) return { city: fallbackCity, state: fallbackState }

    // Match "City, ST zip" or "City, ST" at end of address string
    const match = address.match(/,\s*([^,]+),\s*([A-Z]{2})(?:\s+\d{5})?/)
    if (match) {
      return { city: match[1].trim(), state: match[2].trim() }
    }

    return { city: fallbackCity, state: fallbackState }
  }

  // ─── Map Serper category string to our label ──────────────────────────────

  _resolveCategory(raw) {
    if (!raw) return 'Local Business'
    const lower = raw.toLowerCase()

    const map = [
      [['restaurant', 'dining', 'eatery', 'bistro', 'diner', 'grill', 'steakhouse', 'sushi', 'pizza', 'taco', 'burger'], 'Restaurant'],
      [['cafe', 'coffee', 'bakery', 'pastry'], 'Cafe'],
      [['bar', 'pub', 'tavern', 'brewery', 'lounge'], 'Bar'],
      [['salon', 'hair', 'barber', 'beauty', 'nail'], 'Salon'],
      [['spa', 'massage', 'wellness'], 'Spa'],
      [['gym', 'fitness', 'crossfit', 'yoga', 'pilates'], 'Gym'],
      [['doctor', 'physician', 'medical', 'clinic', 'urgent care', 'hospital'], 'Medical'],
      [['dentist', 'dental', 'orthodont'], 'Dental'],
      [['lawyer', 'attorney', 'legal', 'law firm'], 'Legal'],
      [['accountant', 'accounting', 'cpa', 'bookkeeping', 'tax'], 'Accounting'],
      [['real estate', 'realtor', 'property'], 'Real Estate'],
      [['auto repair', 'mechanic', 'tire', 'oil change', 'transmission'], 'Auto Repair'],
      [['car dealer', 'auto dealer', 'dealership'], 'Auto Dealer'],
      [['electrician', 'electrical'], 'Electrician'],
      [['plumber', 'plumbing'], 'Plumber'],
      [['contractor', 'construction', 'builder', 'remodel'], 'Contractor'],
      [['painter', 'painting'], 'Painter'],
      [['roofing', 'roofer'], 'Roofing'],
      [['florist', 'flower'], 'Florist'],
      [['retail', 'store', 'shop', 'boutique'], 'Retail'],
      [['pharmacy', 'drug store'], 'Pharmacy'],
      [['vet', 'veterinary', 'animal hospital', 'pet'], 'Veterinary'],
      [['hotel', 'motel', 'inn', 'lodge', 'resort'], 'Hotel'],
      [['moving', 'mover', 'relocation'], 'Moving'],
      [['laundry', 'dry clean'], 'Laundry'],
      [['locksmith'], 'Locksmith'],
      [['insurance'], 'Insurance'],
      [['financial', 'bank', 'credit union', 'mortgage'], 'Financial'],
      [['cleaning', 'maid', 'janitorial'], 'Cleaning'],
      [['landscaping', 'lawn', 'gardening'], 'Landscaping'],
      [['pest control', 'exterminator'], 'Pest Control'],
      [['tutoring', 'school', 'academy', 'learning'], 'Education'],
      [['daycare', 'child care', 'preschool'], 'Childcare'],
    ]

    for (const [keywords, label] of map) {
      if (keywords.some((k) => lower.includes(k))) return label
    }

    return raw.length < 40 ? raw : 'Local Business'
  }
}
