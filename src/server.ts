import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { chromium } from 'playwright'
import sharp from 'sharp'

const app = new Hono()

// Rate limiting: Map<apiKey, {count, reset}>
const rateLimitMap = new Map<string, { count: number; reset: number }>()

// Cache: Map<url+format, {buffer, format, timestamp}>
const cacheMap = new Map<string, { buffer: Buffer; format: string; timestamp: number }>()

const CACHE_TTL_MS = 60 * 1000
const RATE_LIMIT_MAX = 10
const RATE_LIMIT_WINDOW_MS = 60 * 1000

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

  // Rate limiting check
  const now = Date.now()
  const rateLimitEntry = rateLimitMap.get(apiKey)
  if (!rateLimitEntry || now >= rateLimitEntry.reset) {
    rateLimitMap.set(apiKey, { count: 1, reset: now + RATE_LIMIT_WINDOW_MS })
  } else {
    if (rateLimitEntry.count >= RATE_LIMIT_MAX) {
      return c.json({ error: 'Rate limit exceeded. Max 10 requests per minute.' }, 429)
    }
    rateLimitEntry.count++
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

  // Cache key
  const cacheKey = `${url}:${format}`
  const cached = cacheMap.get(cacheKey)
  if (cached && now < cached.timestamp + CACHE_TTL_MS) {
    const contentType = getContentType(format)
    return c.body(new Uint8Array(cached.buffer), 200, {
      'Content-Type': contentType,
      'X-Cache': 'HIT'
    })
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

    // Cache the result
    cacheMap.set(cacheKey, { buffer, format, timestamp: now })

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
