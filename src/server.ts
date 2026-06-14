import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { chromium, Browser, BrowserContext } from 'playwright'
import sharp from 'sharp'
import Redis from 'ioredis'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { lookup } from 'node:dns/promises'

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
  const rootKey = process.env.UNKEY_ROOT_KEY

  // Playground bypass — used by the Next.js proxy route
  if (apiKey === 'playground_bypass' || (rootKey && apiKey === rootKey)) {
    return { valid: true, ownerId: 'playground', plan: 'pro' }
  }

  // Dev fallback: static API_KEYS env var (no Unkey configured).
  // v2 verify requires a workspace root key, so fall back when it's missing.
  if (!rootKey) {
    const validKeys = (process.env.API_KEYS ?? '').split(',').map((k) => k.trim()).filter(Boolean)
    if (validKeys.includes(apiKey)) return { valid: true, ownerId: 'static-key', plan: 'free' }
    return { valid: false, plan: 'free', error: 'Invalid API key' }
  }

  // Verify against Unkey v2 (https://api.unkey.com/v2/keys.verifyKey).
  // - api.unkey.dev/v1 was decommissioned (causes ENOTFOUND in fetch).
  // - v2 requires Bearer auth with the workspace root key.
  // - v2 body is { key } only (no apiId); response is nested under `data`.
  try {
    const res = await fetch('https://api.unkey.com/v2/keys.verifyKey', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${rootKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: apiKey }),
    })

    if (!res.ok) {
      console.error('Unkey API error:', res.status)
      return { valid: false, plan: 'free', error: 'Key verification service unavailable' }
    }

    const body = (await res.json()) as {
      data?: {
        valid: boolean
        code?: string
        keyId?: string
        ownerId?: string
        meta?: { plan?: string }
      }
      error?: { title?: string }
    }

    const data = body.data
    if (!data || !data.valid) {
      return {
        valid: false,
        plan: 'free',
        error: data?.code ?? body.error?.title ?? 'Invalid API key',
      }
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

// ─── SSRF Guard (B8: backend must not rely on the frontend proxy's guard) ──────
// Direct callers — agents via /api/mcp, or anyone with a key hitting /screenshot —
// bypass the frontend's lib/safe-url.ts entirely, so we re-validate here.
function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) → test the embedded v4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) ip = mapped[1]

  if (ip.includes('.')) {
    const o = ip.split('.').map(Number)
    if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true // malformed → reject
    const [a, b] = o
    if (a === 0 || a === 10 || a === 127) return true            // this-host / private / loopback
    if (a === 169 && b === 254) return true                       // link-local (AWS metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true              // private
    if (a === 192 && b === 168) return true                       // private
    if (a === 100 && b >= 64 && b <= 127) return true             // CGNAT
    if (a >= 224) return true                                     // multicast / reserved
    return false
  }
  // IPv6
  const v = ip.toLowerCase()
  if (v === '::1' || v === '::') return true                      // loopback / unspecified
  if (v.startsWith('fc') || v.startsWith('fd')) return true       // unique-local fc00::/7
  if (v.startsWith('fe80')) return true                           // link-local
  return false
}

async function validateSafeUrl(raw: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, reason: 'Malformed URL' } }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported scheme "${u.protocol}" — only http/https` }
  }
  if (u.username || u.password) return { ok: false, reason: 'URLs with embedded credentials are not allowed' }

  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.cluster.local')) {
    return { ok: false, reason: `Blocked internal hostname "${host}"` }
  }
  // IP literal in the host → check directly
  const literal = host.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    if (isPrivateIp(literal)) return { ok: false, reason: `Blocked private/reserved IP "${literal}"` }
    return { ok: true }
  }
  // Hostname → resolve and check EVERY address (defends against DNS pointing at private space)
  try {
    const addrs = await lookup(host, { all: true })
    if (addrs.length === 0) return { ok: false, reason: `Hostname "${host}" did not resolve` }
    for (const { address } of addrs) {
      if (isPrivateIp(address)) return { ok: false, reason: `Hostname "${host}" resolves to private IP ${address}` }
    }
  } catch {
    return { ok: false, reason: `Could not resolve hostname "${host}"` }
  }
  return { ok: true }
}

// ─── Core capture (shared by /screenshot and /api/mcp — wrap, don't rebuild) ───
interface CaptureOpts {
  url: string
  format: string
  fullPage: boolean
  width: number
  height: number
  includeText: boolean
  aiExtract?: Record<string, boolean>
  ownerId: string
}
type CaptureResult =
  | { ok: true; buffer: Buffer; contentType: string; format: string; width: number; height: number
      renderTime: number; cached: boolean; pageText: string | null; aiData?: Record<string, unknown>; aiError?: string }
  | { ok: false; kind: 'ssrf' | 'capture'; message: string }

async function performCapture(opts: CaptureOpts): Promise<CaptureResult> {
  const { url, format, fullPage, width, height, includeText, aiExtract, ownerId } = opts
  const startTime = Date.now()

  // SSRF guard — fail fast before touching the browser
  const safe = await validateSafeUrl(url)
  if (!safe.ok) return { ok: false, kind: 'ssrf', message: safe.reason }

  // Cache (image-only modes, mirrors the original handler)
  const cacheKey = `cache:${url}:${format}:${fullPage}`
  const now = Date.now()
  if (!includeText && !aiExtract) {
    if (redis) {
      try {
        const hit = await redis.get(cacheKey)
        if (hit) {
          const buf = Buffer.from(hit, 'base64')
          logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: buf.length / 1024, cached: true })
          return { ok: true, buffer: buf, contentType: getContentType(format), format, width, height, renderTime: 0, cached: true, pageText: null }
        }
      } catch (err) { console.error('Redis cache get error:', err) }
    } else {
      const cached = cacheMap.get(cacheKey)
      if (cached && now < cached.timestamp + CACHE_TTL_MS) {
        logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: cached.buffer.length / 1024, cached: true })
        return { ok: true, buffer: cached.buffer, contentType: getContentType(format), format, width, height, renderTime: 0, cached: true, pageText: null }
      }
    }
  }

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

    let pageText: string | null = null
    if (includeText || aiExtract) {
      try {
        pageText = await page.evaluate(() => document.body.innerText)
        pageText = pageText?.replace(/\n\s*\n/g, '\n\n').trim() ?? null
      } catch (err) {
        pageText = `extraction failed: ${err instanceof Error ? err.message : 'unknown'}`
      }
    }

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

    // AI extraction — a Bedrock failure is reported via aiError; the image stays valid.
    let aiData: Record<string, unknown> | undefined
    let aiError: string | undefined
    if (aiExtract && bedrockClient && pageText) {
      try {
        const fields = Object.keys(aiExtract).filter((k) => aiExtract[k])
        const prompt = `Extract structured data from this webpage. Return ONLY valid JSON with requested fields.\n- page_type: one of [pricing, docs, blog, landing, product, other]\n- prices: array of price strings\n- headings: array of main headings\n- ctas: array of CTA button texts\nNo explanation. Just JSON.\n\nPage content:\n${pageText.slice(0, 8000)}\n\nRequested fields: ${JSON.stringify(fields)}`
        const response = await bedrockClient.send(
          new ConverseCommand({
            modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
            messages: [{ role: 'user', content: [{ text: prompt }] }],
            inferenceConfig: { maxTokens: 1024, temperature: 0 },
          })
        )
        const result = response.output?.message?.content?.[0]?.text
        if (result) {
          try { aiData = JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()) }
          catch { aiData = { raw: result } }
        }
      } catch (err) {
        aiError = err instanceof Error ? err.message : 'Unknown error'
        console.error('Bedrock error:', aiError)
      }
    }

    const renderTime = Date.now() - startTime
    if (redis) {
      try { await redis.setex(cacheKey, 60, buffer.toString('base64')) } catch {}
    } else {
      cacheMap.set(cacheKey, { buffer, format, timestamp: now })
    }
    logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: renderTime, sizeKb: buffer.length / 1024, cached: false })

    return { ok: true, buffer, contentType, format, width, height, renderTime, cached: false, pageText, aiData, aiError }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('Screenshot error:', msg)
    logScreenshot({ userId: ownerId, url, format, status: 500, timeMs: Date.now() - startTime, sizeKb: 0, cached: false })
    return { ok: false, kind: 'capture', message: msg }
  } finally {
    if (context) await context.close().catch(() => {})
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

  // ── Capture (shared core) ──────────────────────────────────────────────────
  const r = await performCapture({ url, format, fullPage, width, height, includeText, aiExtract, ownerId })
  if (!r.ok) {
    if (r.kind === 'ssrf') return c.json({ error: 'Blocked URL', detail: r.message }, 400)
    return c.json({ error: 'Screenshot failed', detail: r.message }, 500)
  }
  // Preserve existing behavior: a Bedrock failure during ai_extract is a 500.
  if (aiExtract && r.aiError) {
    return c.json({ error: 'AI extraction failed', detail: r.aiError }, 500)
  }

  // JSON response for text/AI modes
  if (includeText || aiExtract) {
    return c.json({
      screenshot_url: null,
      format: r.format,
      width: r.width,
      height: r.height,
      render_time_ms: r.renderTime,
      cached: r.cached,
      text: includeText ? r.pageText : undefined,
      ai_data: r.aiData,
    })
  }

  return c.body(new Uint8Array(r.buffer), 200, r.cached
    ? { 'Content-Type': r.contentType, 'X-Cache': 'HIT' }
    : { 'Content-Type': r.contentType, 'X-Cache': 'MISS', 'X-Render-Time': String(r.renderTime) })
})

// ─── MCP Server (Stage 2 — streamable HTTP, JSON-RPC 2.0 at POST /api/mcp) ─────
// Hand-rolled per SPEC_MCP_SERVER.md §4 (3 small methods). Wraps performCapture;
// no screenshot/extract logic rebuilt. SSE / server-initiated msgs are out of scope.
const MCP_PROTOCOL_VERSION = '2025-06-18'

const SHOTBASE_CAPTURE_TOOL = {
  name: 'shotbase_capture',
  description:
    'Capture a web page AND get structured intelligence (page type, headings, CTAs, prices) ' +
    'in one call. Returns the rendered image plus extracted JSON — the fused result agents need.',
  inputSchema: {
    type: 'object',
    properties: {
      url:       { type: 'string', description: 'Page to capture. Required.' },
      extract:   { type: 'boolean', default: true, description: 'Return structured intelligence alongside the image.' },
      format:    { type: 'string', enum: ['png', 'jpeg', 'webp', 'pdf'], default: 'png' },
      full_page: { type: 'boolean', default: false },
      viewport:  { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
    },
    required: ['url'],
  },
} as const

function rpcError(id: unknown, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

app.get('/api/mcp', (c) => c.json(rpcError(null, -32000, 'Method Not Allowed: use POST'), 405))

app.post('/api/mcp', async (c) => {
  let req: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> } | null = null
  try { req = await c.req.json() } catch { return c.json(rpcError(null, -32700, 'Parse error'), 200) }
  if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
    return c.json(rpcError(req?.id, -32600, 'Invalid Request'), 200)
  }
  const { id, method, params } = req
  const isNotification = id === undefined || id === null

  // Auth on every request (spec §2). Missing/invalid key → -32001 unauthorized.
  const authHeader = c.req.header('Authorization')
  const apiKey = authHeader?.match(/^Bearer\s+(.+)$/)?.[1]?.trim()
  if (!apiKey) {
    if (isNotification) return c.body(null, 202)
    return c.json(rpcError(id, -32001, 'unauthorized'), 200)
  }
  const keyResult = await verifyKey(apiKey)
  if (!keyResult.valid) {
    if (isNotification) return c.body(null, 202)
    return c.json(rpcError(id, -32001, 'unauthorized'), 200)
  }

  switch (method) {
    case 'initialize':
      return c.json(rpcResult(id, {
        protocolVersion: (params?.protocolVersion as string) ?? MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'shotbase', version: '1.0.0' },
      }))

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return c.body(null, 202)

    case 'tools/list':
      return c.json(rpcResult(id, { tools: [SHOTBASE_CAPTURE_TOOL] }))

    case 'tools/call': {
      const toolName = params?.name
      if (toolName !== 'shotbase_capture') {
        return c.json(rpcError(id, -32602, `Unknown tool "${String(toolName)}"`), 200)
      }
      const args = (params?.arguments ?? {}) as Record<string, unknown>
      const url = args.url
      if (typeof url !== 'string' || !url.trim()) {
        return c.json(rpcResult(id, { content: [{ type: 'text', text: 'Error: "url" is required.' }], isError: true }))
      }

      // Rate limit — same per-plan buckets as /screenshot.
      if (await checkRateLimit(apiKey, keyResult.plan)) {
        const limit = getRateLimitPerMinute(keyResult.plan)
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text: `Rate limit exceeded. ${keyResult.plan} plan allows ${limit} requests/minute.` }],
          isError: true,
        }))
      }

      const extract  = args.extract !== false // default true
      const viewport = (args.viewport ?? {}) as { width?: number; height?: number }
      const r = await performCapture({
        url,
        format: typeof args.format === 'string' ? args.format : 'png',
        fullPage: args.full_page === true,
        width: typeof viewport.width === 'number' ? viewport.width : 1440,
        height: typeof viewport.height === 'number' ? viewport.height : 900,
        includeText: false,
        aiExtract: extract ? { page_type: true, headings: true, ctas: true, prices: true } : undefined,
        ownerId: keyResult.ownerId ?? 'unknown',
      })

      if (!r.ok) {
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text: r.kind === 'ssrf' ? `Blocked URL: ${r.message}` : `Capture failed: ${r.message}` }],
          isError: true,
        }))
      }

      const content: Array<Record<string, unknown>> = [
        { type: 'image', data: r.buffer.toString('base64'), mimeType: r.contentType },
      ]
      const out: Record<string, unknown> = { content, isError: false }
      if (extract) {
        if (r.aiData) {
          content.push({ type: 'text', text: JSON.stringify(r.aiData) })
          out.structuredContent = r.aiData
        } else {
          // DEFERRED path: capture succeeded, intelligence unavailable (e.g. Bedrock gated).
          // Goes green automatically once the model returns JSON — no code change needed.
          content.push({ type: 'text', text: `extraction_unavailable: ${r.aiError ?? 'model not reachable'}` })
        }
      }
      return c.json(rpcResult(id, out))
    }

    default:
      if (isNotification) return c.body(null, 202)
      return c.json(rpcError(id, -32601, `Method not found: ${method}`), 200)
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT ?? 3000)
console.log(`Shotbase starting on port ${port}`)
serve({ fetch: app.fetch, port })
