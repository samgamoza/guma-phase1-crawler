import { Queue, QueueEvents } from 'bullmq'
import { logger } from '../utils/logger.js'

const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379',
}

/**
 * crawlQueue — jobs to scrape a category+city combination
 *
 * Job data shape:
 * {
 *   category: string,     // e.g. 'Restaurants'
 *   city: string,         // e.g. 'New York'
 *   state: string,        // e.g. 'NY'
 *   maxPages: number,     // default 5
 *   jobId: string,        // crawl_jobs table FK
 * }
 */
export const crawlQueue = new Queue('guma-crawl', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 100 },
  },
})

/**
 * generateQueue — jobs to trigger AI site generation after crawl
 *
 * Job data shape:
 * { businessId: string }
 */
export const generateQueue = new Queue('guma-generate', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5_000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 200 },
  },
})

// ─── Queue helpers ────────────────────────────────────────────────────────

export async function enqueueCrawlJob({ category, city, state, maxPages = 5, source = 'yellowpages', dbJobId }) {
  const jobName = `crawl:${source}:${category}:${city}-${state}`
  const job = await crawlQueue.add(
    jobName,
    { category, city, state, maxPages, source, jobId: dbJobId },
    { jobId: `${source}-${category}-${city}-${state}-${Date.now()}` }
  )
  logger.info(`Enqueued crawl job: ${jobName} (${job.id})`)
  return job
}

export async function enqueueGenerateJob(businessId) {
  const job = await generateQueue.add(
    `generate:${businessId}`,
    { businessId },
    { jobId: `gen-${businessId}` }
  )
  return job
}

// ─── Queue event logging ──────────────────────────────────────────────────

export function attachQueueLogging() {
  const events = new QueueEvents('guma-crawl', { connection })

  events.on('completed', ({ jobId }) => {
    logger.info(`Crawl job completed: ${jobId}`)
  })

  events.on('failed', ({ jobId, failedReason }) => {
    logger.error(`Crawl job failed: ${jobId}`, { reason: failedReason })
  })

  events.on('stalled', ({ jobId }) => {
    logger.warn(`Crawl job stalled: ${jobId}`)
  })
}
