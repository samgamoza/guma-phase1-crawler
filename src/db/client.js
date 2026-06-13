import { createClient } from '@supabase/supabase-js'
import { logger } from '../utils/logger.js'

let _client = null

export function getSupabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_KEY
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
    _client = createClient(url, key, { auth: { persistSession: false } })
  }
  return _client
}

/**
 * Upsert a batch of scraped businesses.
 * Uses slug as the conflict key so re-runs are idempotent.
 */
export async function upsertBusinesses(businesses) {
  const db = getSupabase()
  const { data, error } = await db
    .from('businesses')
    .upsert(businesses, { onConflict: 'slug', ignoreDuplicates: false })
    .select('id, slug')

  if (error) {
    logger.error('DB upsert error', { error: error.message })
    throw error
  }

  return data
}

/**
 * Create or update a crawl_jobs record.
 */
export async function upsertCrawlJob(job) {
  const db = getSupabase()
  const { data, error } = await db
    .from('crawl_jobs')
    .upsert(job, { onConflict: 'id' })
    .select('id')
    .single()

  if (error) {
    logger.error('DB crawl job upsert error', { error: error.message })
    throw error
  }

  return data
}

export async function updateCrawlJob(id, patch) {
  const db = getSupabase()
  const { error } = await db.from('crawl_jobs').update(patch).eq('id', id)
  if (error) logger.error('DB crawl job update error', { error: error.message })
}

/**
 * Check if a business slug already exists — used to skip duplicates
 * when the full batch upsert isn't suitable.
 */
export async function slugExists(slug) {
  const db = getSupabase()
  const { count } = await db
    .from('businesses')
    .select('id', { count: 'exact', head: true })
    .eq('slug', slug)
  return (count || 0) > 0
}
