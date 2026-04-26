import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { chromium } from 'playwright'
import sharp from 'sharp'
import Redis from 'ioredis'

const app = new Hono()

// Redis client - will be null if connection fails
let redis: Redis | null = null

// Fallback in-memory stores if Redis is unavailable
const rateLimitMap = new Map<string, { count: number; reset: number }>()
const cacheMap = new Map<string, { buffer: Buffer; format: string; timestamp: number }>()

const CACHE_TTL_MS = 60 * 1000
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 1000

// Connect to Redis on startup
const redisUrl = process.env.REDIS_URL
if (redisUrl) {
  redis = new Redis(redisUrl)
  redis.on('error', (err) => {
    console.error('Redis connection error:', err.message)
  })
  redis.on('connect', () => {
    console.log('Redis connected')
  })
} else {
  console.log('Redis not configured, using in-memory fallback')
}

app.get('/health', (c) => c.json({ status: 'ok', service: 'shotbase' }))

app.post('/screenshot', async (c) => {
  const authorization = c.req.header('Authorization')
  if (!authorization) {
    return c.json({ error: 'Missing API key' }, 401)
  }

  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  const validKeys = (process.env.API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  if (!validKeys.includes(apiKey)) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  // Rate limiting check with Redis
  const now = Date.now()
  let rateLimited = false

  if (redis) {
    try {
      const rateLimitKey = `ratelimit:${apiKey}`
      const currentCount = await redis.incr(rateLimitKey)
      const ttl = await redis.ttl(rateLimitKey)

      if (ttl === -1) {
        // First request, set expiry
        await redis.expire(rateLimitKey, 60)
      }

      if (currentCount > RATE_LIMIT_MAX) {
        rateLimited = true
      }
    } catch (err) {
      console.error('Redis rate limit error:', err)
      // Fallback to in-memory
      const rateLimitEntry = rateLimitMap.get(apiKey)
      if (!rateLimitEntry || now >= rateLimitEntry.reset) {
        rateLimitMap.set(apiKey, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS })
      } else {
        if (rateLimitEntry.count >= RATE_LIMIT_MAX) {
          rateLimited = true
        } else {
          rateLimitEntry.count++
        }
      }
    }
  } else {
    // In-memory fallback
    const rateLimitEntry = rateLimitMap.get(apiKey)
    if (!rateLimitEntry || now >= rateLimitEntry.reset) {
      rateLimitMap.set(apiKey, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS })
    } else {
      if (rateLimitEntry.count >= RATE_LIMIT_MAX) {
        rateLimited = true
      } else {
        rateLimitEntry.count++
      }
    }
  }

  if (rateLimited) {
    return c.json({ error: 'Rate limit exceeded. Max 10 requests per minute.' }, 429)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }

  const url = (body as { url?: unknown } | null)?.url
  if (typeof url !== 'string' || url.trim().length === 0) {
    return c.json({ error: 'Missing url' }, 400)
  }

  // Extract options with defaults
  const format = ((body as { format?: unknown } | null)?.format as string) ?? 'png'
  const fullPage = ((body as { full_page?: unknown } | null)?.full_page as boolean) ?? false
  const width = ((body as { width?: unknown } | null)?.width as number) ?? 1440
  const height = ((body as { height?: unknown } | null)?.height as number) ?? 900

  // Cache check with Redis
  const cacheKey = `cache:${url}:${format}`

  if (redis) {
    try {
      const cachedBase64 = await redis.get(cacheKey)
      if (cachedBase64) {
        const cachedBuffer = Buffer.from(cachedBase64, 'base64')
        const contentType = getContentType(format)
        return c.body(new Uint8Array(cachedBuffer), 200, {
          'Content-Type': contentType,
          'X-Cache': 'HIT'
        })
      }
    } catch (err) {
      console.error('Redis cache get error:', err)
    }
  } else {
    // In-memory fallback
    const cached = cacheMap.get(cacheKey)
    if (cached && now < cached.timestamp + CACHE_TTL_MS) {
      const contentType = getContentType(format)
      return c.body(new Uint8Array(cached.buffer), 200, {
        'Content-Type': contentType,
        'X-Cache': 'HIT'
      })
    }
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })

    let buffer: Buffer
    let contentType: string

    if (format === 'pdf') {
      const pdf = await page.pdf({ format: 'A4', printBackground: true })
      buffer = Buffer.from(pdf)
      contentType = 'application/pdf'
    } else if (format === 'jpeg') {
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, fullPage })
      buffer = Buffer.from(screenshot)
      contentType = 'image/jpeg'
    } else if (format === 'webp') {
      const png = await page.screenshot({ type: 'png', fullPage })
      const converted = await sharp(png).webp().toBuffer()
      buffer = converted
      contentType = 'image/webp'
    } else {
      // png (default)
      const png = await page.screenshot({ type: 'png', fullPage })
      buffer = Buffer.from(png)
      contentType = 'image/png'
    }

    // Cache the result in Redis
    if (redis) {
      try {
        await redis.setex(cacheKey, 60, buffer.toString('base64'))
      } catch (err) {
        console.error('Redis cache set error:', err)
      }
    } else {
      // In-memory fallback
      cacheMap.set(cacheKey, { buffer, format, timestamp: now })
    }

    return c.body(new Uint8Array(buffer), 200, {
      'Content-Type': contentType,
      'X-Cache': 'MISS'
    })
  } finally {
    await browser.close()
  }
})

function getContentType(format: string): string {
  switch (format) {
    case 'png':
      return 'image/png'
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'pdf':
      return 'application/pdf'
    default:
      return 'image/png'
  }
}

const port = Number(process.env.PORT ?? 3000)
console.log(`Shotbase running on port ${port}`)

serve({ fetch: app.fetch, port })
