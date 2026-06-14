/**
 * HTTP API server for the crawler service.
 * Allows the frontend admin to trigger crawl jobs without direct Redis access.
 *
 * POST /jobs  { category, city, state, maxPages }
 * GET  /health
 */
import 'dotenv/config'
import http from 'node:http'
import { enqueueCrawlJob } from './queue/queues.js'
import { upsertCrawlJob } from './db/client.js'
import { logger } from './utils/logger.js'

const PORT   = process.env.PORT || process.env.CRAWLER_API_PORT || 3001
const SECRET = process.env.ADMIN_API_SECRET || ''

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', chunk => { data += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) }
    })
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  // Auth check
  if (SECRET && req.headers['x-admin-secret'] !== SECRET) {
    return json(res, 401, { error: 'Unauthorized' })
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, service: 'guma-crawler' })
  }

  if (req.method === 'POST' && req.url === '/jobs') {
    try {
      const body = await readBody(req)
      const {
        category = 'Restaurants',
        city     = 'Austin',
        state    = 'TX',
        maxPages = 5,
        source   = 'yellowpages',  // 'yellowpages' | 'googleplaces'
      } = body

      const dbJob = await upsertCrawlJob({
        source,
        category,
        region: `${city}, ${state}`,
        status: 'pending',
      })

      const job = await enqueueCrawlJob({ category, city, state, maxPages, source, dbJobId: dbJob.id })

      logger.info(`API triggered crawl: ${category} / ${city}, ${state}`)
      return json(res, 200, { ok: true, jobId: job.id, dbJobId: dbJob.id })
    } catch (err) {
      logger.error('API crawl enqueue failed', { error: err.message })
      return json(res, 500, { error: err.message })
    }
  }

  json(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  logger.info(`Crawler API listening on :${PORT}`)
})
