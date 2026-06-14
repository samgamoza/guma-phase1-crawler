import 'dotenv/config'
import { Worker } from 'bullmq'
import { YellowPagesScraper } from '../crawler/yellowpages.js'
import { GooglePlacesScraper } from '../crawler/googleplaces.js'
import { SerperScraper } from '../crawler/serper.js'
import { ApifyScraper } from '../crawler/apify.js'
import { BrightDataScraper } from '../crawler/brightdata.js'
import { ProxyManager } from '../utils/proxy.js'
import { RateLimiter } from '../utils/rateLimiter.js'
import { upsertBusinesses, updateCrawlJob } from '../db/client.js'
import { enqueueGenerateJob } from './queues.js'
import { logger } from '../utils/logger.js'

const CONCURRENCY = parseInt(process.env.CRAWL_CONCURRENCY || '2', 10)

const proxyManager = ProxyManager.fromEnv()
const rateLimiter = RateLimiter.fromEnv()

// YellowPages: one shared browser across all worker tasks
const ypScraper = new YellowPagesScraper({ proxyManager, rateLimiter })
await ypScraper.init()

// Google Places: stateless HTTP client, instantiate lazily if key is present
let gpScraper = null
if (process.env.GOOGLE_PLACES_API_KEY) {
  gpScraper = new GooglePlacesScraper()
  logger.info('Google Places scraper ready')
} else {
  logger.warn('GOOGLE_PLACES_API_KEY not set — Google Places source disabled')
}

// Serper: stateless HTTP client, instantiate lazily if key is present
let serperScraper = null
if (process.env.SERPER_API_KEY) {
  serperScraper = new SerperScraper()
  logger.info('Serper scraper ready')
} else {
  logger.warn('SERPER_API_KEY not set — Serper source disabled')
}

// Apify: cloud actor runner, instantiate lazily if token is present
let apifyScraper = null
if (process.env.APIFY_API_TOKEN) {
  apifyScraper = new ApifyScraper()
  logger.info('Apify scraper ready')
} else {
  logger.warn('APIFY_API_TOKEN not set — Apify source disabled')
}

// Bright Data: dataset API or proxy mode, instantiate lazily if token is present
let brightDataScraper = null
if (process.env.BRIGHT_DATA_API_TOKEN) {
  brightDataScraper = new BrightDataScraper()
  logger.info(`Bright Data scraper ready (mode: ${process.env.BRIGHT_DATA_MODE || 'dataset'})`)
} else {
  logger.warn('BRIGHT_DATA_API_TOKEN not set — Bright Data source disabled')
}

const worker = new Worker(
  'guma-crawl',
  async (job) => {
    const { category, city, state, maxPages = 5, jobId, source = 'yellowpages' } = job.data
    const label = `[${source}] ${category} / ${city}, ${state}`

    logger.info(`Worker processing: ${label}`)

    if (jobId) {
      await updateCrawlJob(jobId, { status: 'running', started_at: new Date().toISOString() })
    }

    await job.updateProgress(5)

    // ── Select scraper based on source ───────────────────────────────────────
    const scraper =
      source === 'googleplaces' ? gpScraper :
      source === 'serper'       ? serperScraper :
      source === 'apify'        ? apifyScraper :
      source === 'brightdata'   ? brightDataScraper :
      ypScraper

    if (!scraper) {
      const msg = `Scraper for source "${source}" is not available (missing API key?)`
      logger.error(msg)
      if (jobId) await updateCrawlJob(jobId, { status: 'failed', finished_at: new Date().toISOString(), error_log: { message: msg } })
      throw new Error(msg)
    }

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

    // ── Quality gate: skip records missing critical fields ───────────────────
    // Saves Claude API credits — low-quality records rarely convert anyway.
    const qualified = noWebsite.filter((b) => {
      const hasName    = Boolean(b.name?.trim())
      const hasCity    = Boolean(b.city?.trim())
      const hasContact = Boolean(b.phone?.trim() || b.email?.trim())
      const hasAddress = Boolean(b.address?.trim())
      const score      = [hasName, hasCity, hasContact, hasAddress].filter(Boolean).length
      if (score < 2) logger.debug(`Skipping low-quality record: ${b.name || 'unnamed'} (score ${score}/4)`)
      return score >= 2
    })

    logger.info(
      `${label}: ${businesses.length} total, ${noWebsite.length} without website, ${qualified.length} qualified`
    )

    await job.updateProgress(75)

    // ── Save to DB ───────────────────────────────────────────────────────────
    let saved = []
    if (qualified.length > 0) {
      try {
        saved = await upsertBusinesses(qualified)
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
  await ypScraper.close()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

logger.info(`Worker started — concurrency: ${CONCURRENCY}`)
