import 'dotenv/config'
import { Worker } from 'bullmq'
import { YellowPagesScraper } from '../crawler/yellowpages.js'
import { ProxyManager } from '../utils/proxy.js'
import { RateLimiter } from '../utils/rateLimiter.js'
import { upsertBusinesses, updateCrawlJob } from '../db/client.js'
import { enqueueGenerateJob } from './queues.js'
import { logger } from '../utils/logger.js'

const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || '2', 10)

const proxyManager = ProxyManager.fromEnv()
const rateLimiter = RateLimiter.fromEnv()

// One shared browser across all worker tasks
const scraper = new YellowPagesScraper({ proxyManager, rateLimiter })
await scraper.init()

const worker = new Worker(
  'guma-crawl',
  async (job) => {
    const { category, city, state, maxPages = 5, jobId } = job.data
    const label = `${category} / ${city}, ${state}`

    logger.info(`Worker processing: ${label}`)

    if (jobId) {
      await updateCrawlJob(jobId, { status: 'running', started_at: new Date().toISOString() })
    }

    await job.updateProgress(5)

    // ── Scrape ──────────────────────────────────────────────────────────────
    let businesses = []
    try {
      businesses = await scraper.scrapeSearch({ category, city, state, maxPages })
    } catch (err) {
      logger.error(`Scrape failed for ${label}`, { error: err.message })
      if (jobId) {
        await updateCrawlJob(jobId, {
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_log: { message: err.message },
        })
      }
      throw err
    }

    await job.updateProgress(70)

    // ── Filter: only businesses without a website ────────────────────────────
    const noWebsite = businesses.filter((b) => !b.has_website)
    logger.info(
      `${label}: ${businesses.length} total, ${noWebsite.length} without website`
    )

    await job.updateProgress(75)

    // ── Save to DB ───────────────────────────────────────────────────────────
    let saved = []
    if (noWebsite.length > 0) {
      try {
        saved = await upsertBusinesses(noWebsite)
        logger.info(`Saved ${saved.length} businesses to DB`)
      } catch (err) {
        logger.error('DB save failed', { error: err.message })
        throw err
      }
    }

    await job.updateProgress(85)

    // ── Enqueue site generation jobs ─────────────────────────────────────────
    let enqueued = 0
    for (const biz of saved) {
      try {
        await enqueueGenerateJob(biz.id)
        enqueued++
      } catch (err) {
        logger.warn(`Failed to enqueue generation for ${biz.id}`, { error: err.message })
      }
    }

    await job.updateProgress(100)

    // ── Update crawl job record ──────────────────────────────────────────────
    if (jobId) {
      await updateCrawlJob(jobId, {
        status: 'done',
        found: businesses.length,
        processed: saved.length,
        finished_at: new Date().toISOString(),
      })
    }

    logger.info(`Job done: ${label} — saved ${saved.length}, queued ${enqueued} for generation`)

    return { found: businesses.length, saved: saved.length, enqueued }
  },
  {
    connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
    concurrency: CONCURRENCY,
    limiter: {
      max: parseInt(process.env.REQUESTS_PER_MINUTE || '20', 10),
      duration: 60_000,
    },
  }
)

// ── Worker lifecycle logging ────────────────────────────────────────────────

worker.on('completed', (job, result) => {
  logger.info(`Job ${job.id} completed`, result)
})

worker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} failed`, { error: err.message, attempts: job?.attemptsMade })
})

worker.on('stalled', (jobId) => {
  logger.warn(`Job ${jobId} stalled`)
})

worker.on('error', (err) => {
  logger.error('Worker error', { error: err.message })
})

// ── Graceful shutdown ───────────────────────────────────────────────────────

async function shutdown() {
  logger.info('Shutting down worker...')
  await worker.close()
  await scraper.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

logger.info(`Worker started — concurrency: ${CONCURRENCY}`)
