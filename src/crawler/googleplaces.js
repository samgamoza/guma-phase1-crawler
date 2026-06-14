/**
 * GooglePlacesScraper
 *
 * Uses the Google Places API (Text Search + Place Details) to find local
 * businesses without a website. No browser/Playwright needed — pure HTTP.
 *
 * API docs:
 *   Text Search:   https://developers.google.com/maps/documentation/places/web-service/text-search
 *   Place Details: https://developers.google.com/maps/documentation/places/web-service/details
 *
 * Required env: GOOGLE_PLACES_API_KEY
 * Cost: ~$0.017 per Text Search page (20 results), ~$0.017 per Detail lookup
 *       ≈ $0.034 per business record worst case
 */

import slugify from 'slugify'
import { logger } from '../utils/logger.js'

const BASE = 'https://maps.googleapis.com/maps/api/place'

// Fields fetched from Place Details — only request what we need to control cost.
const DETAIL_FIELDS = [
  'name',
  'formatted_phone_number',
  'formatted_address',
  'geometry',
  'website',
  'opening_hours',
  'rating',
  'user_ratings_total',
  'types',
  'address_components',
  'editorial_summary',
  'business_status',
].join(',')

export class GooglePlacesScraper {
  constructor() {
    this.apiKey = process.env.GOOGLE_PLACES_API_KEY
    if (!this.apiKey) throw new Error('Missing GOOGLE_PLACES_API_KEY')
  }

  /**
   * Main entry — mirrors YellowPagesScraper.scrapeSearch() signature.
   * Returns array of normalised business objects ready for DB upsert.
   */
  async scrapeSearch({ category, city, state, maxPages = 5 }) {
    const label = `${category} / ${city}, ${state}`
    logger.info(`[GooglePlaces] Starting search: ${label}`)

    const query = `${category} in ${city}, ${state}`
    const placeIds = await this._collectPlaceIds(query, maxPages)
    logger.info(`[GooglePlaces] Found ${placeIds.length} place IDs for ${label}`)

    const businesses = []
    for (const placeId of placeIds) {
      try {
        const biz = await this._fetchDetail(placeId, city, state)
        if (biz) businesses.push(biz)
      } catch (err) {
        logger.warn(`[GooglePlaces] Detail fetch failed: ${placeId}`, { error: err.message })
      }
    }

    logger.info(`[GooglePlaces] Returning ${businesses.length} businesses for ${label}`)
    return businesses
  }

  // ─── Phase 1: collect place IDs via Text Search ───────────────────────────

  async _collectPlaceIds(query, maxPages) {
    const placeIds = []
    let pageToken = null
    let page = 0

    while (page < maxPages) {
      const params = new URLSearchParams({
        query,
        key: this.apiKey,
        ...(pageToken ? { pagetoken: pageToken } : {}),
      })

      const url = `${BASE}/textsearch/json?${params}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`Text Search HTTP ${res.status}`)

      const data = await res.json()

      if (data.status === 'REQUEST_DENIED') {
        throw new Error(`Google Places API denied: ${data.error_message}`)
      }
      if (data.status === 'OVER_QUERY_LIMIT') {
        logger.warn('[GooglePlaces] Query limit hit — stopping pagination')
        break
      }
      if (!['OK', 'ZERO_RESULTS'].includes(data.status)) {
        logger.warn(`[GooglePlaces] Unexpected status: ${data.status}`)
        break
      }

      for (const result of data.results || []) {
        if (result.place_id) placeIds.push(result.place_id)
      }

      pageToken = data.next_page_token || null
      page++

      if (!pageToken) break

      // Google requires a short delay before using next_page_token
      await new Promise((r) => setTimeout(r, 2000))
    }

    return [...new Set(placeIds)]
  }

  // ─── Phase 2: fetch full detail for a single place ────────────────────────

  async _fetchDetail(placeId, city, state) {
    const params = new URLSearchParams({
      place_id: placeId,
      fields: DETAIL_FIELDS,
      key: this.apiKey,
    })

    const url = `${BASE}/details/json?${params}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Place Details HTTP ${res.status}`)

    const data = await res.json()
    if (data.status !== 'OK' || !data.result) {
      logger.debug(`[GooglePlaces] Skipping ${placeId}: status ${data.status}`)
      return null
    }

    const r = data.result

    // Skip permanently closed businesses
    if (r.business_status === 'PERMANENTLY_CLOSED') return null

    const hasWebsite = Boolean(r.website)
    const name = r.name?.trim()
    if (!name) return null

    // Extract city/state from address_components for accuracy
    const addrCity  = this._extractComponent(r.address_components, 'locality') || city
    const addrState = this._extractComponent(r.address_components, 'administrative_area_level_1') || state
    const zip       = this._extractComponent(r.address_components, 'postal_code') || ''

    // Build hours string
    const hours = (r.opening_hours?.weekday_text || []).join(', ')

    // Primary category from types
    const category = this._resolveCategory(r.types || [])

    return this._normalise({
      name,
      phone:        r.formatted_phone_number || null,
      address:      r.formatted_address || null,
      city:         addrCity,
      state:        addrState,
      zip,
      category,
      description:  r.editorial_summary?.text || null,
      has_website:  hasWebsite,
      website_url:  r.website || null,
      hours,
      rating:       r.rating?.toString() || null,
      review_count: r.user_ratings_total || 0,
      email:        null, // Google Places API doesn't return email
      place_id:     placeId,
    })
  }

  // ─── Normalise to DB schema (matches YellowPages output) ─────────────────

  _normalise(raw) {
    const name = raw.name.replace(/\s+/g, ' ').trim()
    const slug = slugify(`${name}-${raw.city || ''}-${raw.state || ''}`, {
      lower: true,
      strict: true,
      trim: true,
    }).substring(0, 120)

    return {
      name,
      slug,
      category:   raw.category,
      phone:      raw.phone,
      email:      raw.email,
      address:    raw.address,
      city:       raw.city,
      country:    'US',
      source_url: `https://maps.google.com/?cid=${raw.place_id}`,
      source_dir: 'googleplaces',
      has_website: raw.has_website,
      raw_data: {
        state:        raw.state,
        zip:          raw.zip,
        description:  raw.description,
        hours:        raw.hours,
        rating:       raw.rating,
        review_count: raw.review_count,
        website_url:  raw.website_url,
        place_id:     raw.place_id,
      },
      crawled_at: new Date().toISOString(),
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _extractComponent(components = [], type) {
    return components.find((c) => c.types.includes(type))?.long_name || null
  }

  // Map Google's generic `types` array to a human-readable category label
  _resolveCategory(types) {
    const map = {
      restaurant:         'Restaurant',
      food:               'Restaurant',
      cafe:               'Cafe',
      bar:                'Bar',
      beauty_salon:       'Salon',
      hair_care:          'Salon',
      spa:                'Spa',
      gym:                'Gym',
      health:             'Medical',
      doctor:             'Medical',
      dentist:            'Dental',
      lawyer:             'Legal',
      accounting:         'Accounting',
      real_estate_agency: 'Real Estate',
      car_repair:         'Auto Repair',
      car_dealer:         'Auto Dealer',
      electrician:        'Electrician',
      plumber:            'Plumber',
      general_contractor: 'Contractor',
      painter:            'Painter',
      roofing_contractor: 'Roofing',
      florist:            'Florist',
      bakery:             'Bakery',
      store:              'Retail',
      clothing_store:     'Clothing',
      pharmacy:           'Pharmacy',
      pet_store:          'Pet Shop',
      veterinary_care:    'Veterinary',
      lodging:            'Hotel',
      travel_agency:      'Travel',
      moving_company:     'Moving',
      laundry:            'Laundry',
      locksmith:          'Locksmith',
      insurance_agency:   'Insurance',
      bank:               'Financial',
    }

    for (const type of types) {
      if (map[type]) return map[type]
    }
    return 'Local Business'
  }
}
