import 'dotenv/config'
import { enqueueCrawlJob, attachQueueLogging } from './queue/queues.js'
import { upsertCrawlJob } from './db/client.js'
import { logger } from './utils/logger.js'

/**
 * index.js — enqueues crawl jobs from a config list.
 *
 * Run:
 *   node src/index.js           — dry-run, show what would be enqueued
 *   node src/index.js --run     — actually enqueue jobs
 *
 * Separately run the worker process:
 *   node src/queue/worker.js
 */

// ── Crawl targets ────────────────────────────────────────────────────────────
// Edit this list to control what gets crawled.

const CRAWL_TARGETS = [
  // Start small — one category, one city
  { category: 'Restaurants', city: 'New York', state: 'NY', maxPages: 3 },
  { category: 'Plumbers', city: 'Austin', state: 'TX', maxPages: 3 },
  { category: 'Hair Salons', city: 'Chicago', state: 'IL', maxPages: 3 },
  { category: 'Dentists', city: 'Phoenix', state: 'AZ', maxPages: 2 },
  { category: 'Auto Repair', city: 'Miami', state: 'FL', maxPages: 2 },

  // Expand once initial batch validates
  // { category: 'Florists', city: 'Seattle', state: 'WA', maxPages: 3 },
  // { category: 'Lawyers', city: 'Los Angeles', state: 'CA', maxPages: 3 },
]

async function main() {
  const dryRun = !process.argv.includes('--run')

  if (dryRun) {
    logger.info('DRY RUN — pass --run to actually enqueue jobs\n')
    logger.info(`Would enqueue ${CRAWL_TARGETS.length} crawl jobs:`)
    CRAWL_TARGETS.forEach((t, i) => {
      logger.info(`  ${i + 1}. ${t.category} / ${t.city}, ${t.state} (${t.maxPages} pages)`)
    })
    logger.info('\nEstimated businesses per job: 10–25 per page')
    logger.info(`Estimated total: ${CRAWL_TARGETS.reduce((s, t) => s + t.maxPages * 17, 0)} businesses`)
    logger.info('At $0.01/site for AI generation: ~$'
      + (CRAWL_TARGETS.reduce((s, t) => s + t.maxPages * 17, 0) * 0.01).toFixed(2))
    return
  }

  attachQueueLogging()
  logger.info(`Enqueueing ${CRAWL_TARGETS.length} crawl jobs...`)

  for (const target of CRAWL_TARGETS) {
    try {
      // Create DB record first so we can track progress
      const dbJob = await upsertCrawlJob({
        source: 'yellowpages',
        category: target.category,
        region: `${target.city}, ${target.state}`,
        status: 'pending',
      })

      await enqueueCrawlJob({ ...target, dbJobId: dbJob.id })
    } catch (err) {
      logger.error(`Failed to enqueue ${target.category}/${target.city}`, { error: err.message })
    }
  }

  logger.info('All jobs enqueued. Start the worker: node src/queue/worker.js')
  process.exit(0)
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message })
  process.exit(1)
})
