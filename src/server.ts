import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { chromium, Browser, BrowserContext } from 'playwright'
import sharp from 'sharp'
import Redis from 'ioredis'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const app = new Hono()

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis: Redis | null = null
const cacheMap = new Map<string, { buffer: Buffer; format: string; timestamp: number }>()
const CACHE_TTL_MS = 60 * 1000

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL)
  redis.on('error', (err) => console.error('Redis error:', err.message))
  redis.on('connect', () => console.log('✓ Redis connected'))
} else {
  console.log('Redis not configured, using in-memory cache fallback')
}

// ─── Supabase ─────────────────────────────────────────────────────────────────
let supabase: SupabaseClient | null = null
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  console.log('✓ Supabase connected')
} else {
  console.warn('Supabase env vars missing — usage/logs will not be recorded')
}

// ─── AWS Bedrock ──────────────────────────────────────────────────────────────
let bedrockClient: BedrockRuntimeClient | null = null
if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  })
  console.log('✓ AWS Bedrock connected')
}

// ─── Persistent Browser ───────────────────────────────────────────────────────
// Launch once on startup, create lightweight contexts per request
// This eliminates the 2-4s browser cold-start per screenshot
let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    console.log('Launching browser...')
    browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
    console.log('✓ Browser ready')
  }
  return browser
}

// Warm up on startup
getBrowser().catch((err) => console.error('Browser warmup failed:', err))

// ─── Unkey Key Verification ───────────────────────────────────────────────────
interface UnkeyResult {
  valid: boolean
  ownerId?: string
  plan: string
  error?: string
}

async function verifyKey(apiKey: string): Promise<UnkeyResult> {
  const unkeyApiId = process.env.UNKEY_API_ID

  // Playground bypass — used by the Next.js proxy route
  const rootKey = process.env.UNKEY_ROOT_KEY
  if (apiKey === 'playground_bypass' || (rootKey && apiKey === rootKey)) {
    return { valid: true, ownerId: 'playground', plan: 'pro' }
  }

  // Dev fallback: static API_KEYS env var (no Unkey configured)
  if (!unkeyApiId) {
    const validKeys = (process.env.API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    if (validKeys.includes(apiKey)) return { valid: true, ownerId: 'static-key', plan: 'free' }
    return { valid: false, plan: 'free', error: 'Invalid API key' }
  }

  // Verify against Unkey
  try {
    const res = await fetch('https://api.unkey.dev/v1/keys.verifyKey', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiId: unkeyApiId, key: apiKey }),
    })

    if (!res.ok) {
      console.error('Unkey API error:', res.status)
      return { valid: false, plan: 'free', error: 'Key verification service unavailable' }
    }

    const data = (await res.json()) as {
      valid: boolean
      ownerId?: string
      meta?: { plan?: string }
      error?: string
    }

    if (!data.valid) {
      return { valid: false, plan: 'free', error: data.error || 'Invalid API key' }
    }

    return { valid: true, ownerId: data.ownerId, plan: data.meta?.plan ?? 'free' }
  } catch (err) {
    console.error('Unkey verify error:', err)
    return { valid: false, plan: 'free', error: 'Key verification failed' }
  }
}

// ─── Plan-based Rate Limits ───────────────────────────────────────────────────
function getRateLimitPerMinute(plan: string): number {
  switch (plan.toLowerCase()) {
    case 'starter': return 60
    case 'pro':     return 300
    case 'scale':   return 1000
    default:        return 10 // free
  }
}

const inMemoryRateLimit = new Map<string, { count: number; reset: number }>()

async function checkRateLimit(apiKey: string, plan: string): Promise<boolean> {
  const limit = getRateLimitPerMinute(plan)
  const now = Date.now()

  if (redis) {
    try {
      const key = `ratelimit:${apiKey}`
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, 60)
      return count > limit
    } catch (err) {
      console.error('Redis rate limit error, falling back to memory:', err)
    }
  }

  // In-memory fallback
  const entry = inMemoryRateLimit.get(apiKey)
  if (!entry || now >= entry.reset) {
    inMemoryRateLimit.set(apiKey, { count: 1, reset: now + 60_000 })
    return false
  }
  if (entry.count >= limit) return true
  entry.count++
  return false
}

// ─── Supabase Usage Logging ───────────────────────────────────────────────────
async function logScreenshot(data: {
  userId: string
  url: string
  format: string
  status: number
  timeMs: number
  sizeKb: number
  cached: boolean
}) {
  if (!supabase) return
  try {
    await supabase.from('screenshots').insert({
      user_id: data.userId,
      url: data.url,
      format: data.format,
      status: data.status,
      time_ms: data.timeMs,
      size_kb: Math.round(data.sizeKb),
      cached: data.cached,
      created_at: new Date().toISOString(),
    })
  } catch (err) {
    console.error('Supabase log error:', err)
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function getContentType(format: string): string {
  switch (format) {
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'pdf':  return 'application/pdf'
    default:     return 'image/png'
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/health', (c) =>
  c.json({
    status: 'ok',
    service: 'shotbase',
    redis: !!redis,
    supabase: !!supabase,
    bedrock: !!bedrockClient,
    browser: browser?.isConnected() ?? false,
  })
)

app.post('/screenshot', async (c) => {
  const startTime = Date.now()

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authorization = c.req.header('Authorization')
  if (!authorization) return c.json({ error: 'Missing Authorization header' }, 401)

  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) return c.json({ error: 'Invalid authorization format. Use: Bearer <key>' }, 401)

  const keyResult = await verifyKey(apiKey)
  if (!keyResult.valid) return c.json({ error: keyResult.error ?? 'Invalid API key' }, 401)

  const ownerId = keyResult.ownerId ?? 'unknown'
  const plan = keyResult.plan

  // ── Rate limit ────────────────────────────────────────────────────────────
  const rateLimited = await checkRateLimit(apiKey, plan)
  if (rateLimited) {
    const limit = getRateLimitPerMinute(plan)
    return c.json(
      { error: `Rate limit exceeded. ${plan} plan allows ${limit} requests/minute.` },
      429
    )
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: Record<string, unknown> | null = null
  try { body = await c.req.json() } catch { /* stays null */ }

  const url = body?.url
  if (typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'Missing or invalid "url" field' }, 400)
  }

  const format      = (body?.format as string)    ?? 'png'
  const fullPage    = (body?.full_page as boolean) ?? false
  const width       = (body?.width as number)      ?? 1440
  const height      = (body?.height as number)     ?? 900
  const includeText = (body?.include_text as boolean) ?? false
  const aiExtract   = body?.ai_extract as Record<string, boolean> | undefined

  if (aiExtract && !bedrockClient) {
    return c.json({ error: 'AI extraction requires AWS Bedrock credentials on the server' }, 400)
  }

  // ── Cache check ───────────────────────────────────────────────────────────
  const cacheKey = `cache:${url}:${format}:${fullPage}`
  const now = Date.now()

  if (!includeText && !aiExtract) {
    if (redis) {
      try {
        const hit = await redis.get(cacheKey)
        if (hit) {
          const buf = Buffer.from(hit, 'base64')
          logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: buf.length / 1024, cached: true })
          return c.body(new Uint8Array(buf), 200, {
            'Content-Type': getContentType(format),
            'X-Cache': 'HIT',
          })
        }
      } catch (err) { console.error('Redis cache get error:', err) }
    } else {
      const cached = cacheMap.get(cacheKey)
      if (cached && now < cached.timestamp + CACHE_TTL_MS) {
        logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: cached.buffer.length / 1024, cached: true })
        return c.body(new Uint8Array(cached.buffer), 200, {
          'Content-Type': getContentType(format),
          'X-Cache': 'HIT',
        })
      }
    }
  }

  // ── Screenshot ────────────────────────────────────────────────────────────
  const b = await getBrowser()
  let context: BrowserContext | null = null

  try {
    context = await b.newContext()
    const page = await context.newPage()
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })

    // Text extraction
    let pageText: string | null = null
    if (includeText || aiExtract) {
      try {
        pageText = await page.evaluate(() => document.body.innerText)
        pageText = pageText?.replace(/\n\s*\n/g, '\n\n').trim() ?? null
      } catch (err) {
        pageText = `extraction failed: ${err instanceof Error ? err.message : 'unknown'}`
      }
    }

    // Capture image/pdf
    let buffer: Buffer
    let contentType: string

    if (format === 'pdf') {
      buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
      contentType = 'application/pdf'
    } else if (format === 'jpeg') {
      buffer = Buffer.from(await page.screenshot({ type: 'jpeg', quality: 80, fullPage }))
      contentType = 'image/jpeg'
    } else if (format === 'webp') {
      const png = await page.screenshot({ type: 'png', fullPage })
      buffer = await sharp(png).webp().toBuffer()
      contentType = 'image/webp'
    } else {
      buffer = Buffer.from(await page.screenshot({ type: 'png', fullPage }))
      contentType = 'image/png'
    }

    // AI extraction via Bedrock
    let aiData: Record<string, unknown> | undefined
    if (aiExtract && bedrockClient && pageText) {
      try {
        const fields = Object.keys(aiExtract).filter((k) => aiExtract[k])
        const prompt = `Extract structured data from this webpage. Return ONLY valid JSON with requested fields.\n- prices: array of price strings\n- headings: array of main headings\n- ctas: array of CTA button texts\nNo explanation. Just JSON.\n\nPage content:\n${pageText.slice(0, 8000)}\n\nRequested fields: ${JSON.stringify(fields)}`

        const response = await bedrockClient.send(
          new ConverseCommand({
            modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            messages: [{ role: 'user', content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 1024, temperature: 0 },
          })
        )

        const result = response.output?.message?.content?.[0]?.text
        if (result) {
          try {
            aiData = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim())
          } catch {
            aiData = { raw: result }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error('Bedrock error:', msg)
        return c.json({ error: 'AI extraction failed', detail: msg }, 500)
      }
    }

    const renderTime = Date.now() - startTime
    const sizeKb = buffer.length / 1024

    // Cache the result
    if (redis) {
      try { await redis.setex(cacheKey, 60, buffer.toString('base64')) } catch {}
    } else {
      cacheMap.set(cacheKey, { buffer, format, timestamp: now })
    }

    // Log to Supabase (fire and forget)
    logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: renderTime, sizeKb, cached: false })

    // JSON response for text/AI modes
    if (includeText || aiExtract) {
      return c.json({
        screenshot_url: null,
        format,
        width,
        height,
        render_time_ms: renderTime,
        cached: false,
        text: includeText ? pageText : undefined,
        ai_data: aiData,
      })
    }

    return c.body(new Uint8Array(buffer), 200, {
      'Content-Type': contentType,
      'X-Cache': 'MISS',
      'X-Render-Time': String(renderTime),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('Screenshot error:', msg)
    logScreenshot({
      userId: ownerId,
      url,
      format,
      status: 500,
      timeMs: Date.now() - startTime,
      sizeKb: 0,
      cached: false,
    })
    return c.json({ error: 'Screenshot failed', detail: msg }, 500)
  } finally {
    // Close context only — browser stays alive for next request
    if (context) await context.close().catch(() => {})
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 3000)
console.log(`Shotbase starting on port ${port}`)
serve({ fetch: app.fetch, port })
