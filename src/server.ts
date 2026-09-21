import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
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

// Warm up on startup (only when run as the entrypoint — not when imported by tests).
if (require.main === module) {
  getBrowser().catch((err) => console.error('Browser warmup failed:', err))
}

// ─── Browser Concurrency Gate ───────────────────────────────────────────────────
// The browser is a singleton; unbounded simultaneous contexts exhaust CPU/RAM and
// crash the process. This in-process gate caps active captures, queues a bounded
// number of overflow requests, and rejects cleanly past that — no external infra.
const MAX_BROWSER_CONCURRENCY  = Math.max(1, Math.floor(Number(process.env.MAX_BROWSER_CONCURRENCY ?? 4)) || 4)
const MAX_BROWSER_QUEUE        = Math.max(0, Math.floor(Number(process.env.MAX_BROWSER_QUEUE ?? 20)) || 0)
const BROWSER_QUEUE_TIMEOUT_MS = Math.max(0, Math.floor(Number(process.env.BROWSER_QUEUE_TIMEOUT_MS ?? 10_000)) || 0)

type GateErrorKind = 'overloaded' | 'timeout'
export class GateError extends Error {
  kind: GateErrorKind
  constructor(kind: GateErrorKind, message: string) { super(message); this.kind = kind }
}
export interface Permit { release: () => void }

export class BrowserGate {
  private active = 0
  private waiters: Array<{ resolve: (p: Permit) => void; reject: (e: GateError) => void; timer: ReturnType<typeof setTimeout> }> = []
  constructor(
    private readonly maxConcurrency: number,
    private readonly maxQueue: number,
    private readonly queueTimeoutMs: number,
  ) {}

  get activeCount() { return this.active }
  get queuedCount() { return this.waiters.length }

  acquire(): Promise<Permit> {
    // Free slot → take it immediately.
    if (this.active < this.maxConcurrency) {
      this.active++
      return Promise.resolve(this.makePermit())
    }
    // No slot and queue is full → reject rather than grow memory without bound.
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new GateError('overloaded',
        `Server at capacity (${this.maxConcurrency} active, queue full at ${this.maxQueue}).`))
    }
    // Otherwise wait in the bounded queue with a timeout.
    return new Promise<Permit>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer)
        if (i !== -1) this.waiters.splice(i, 1)
        reject(new GateError('timeout', `Timed out after ${this.queueTimeoutMs}ms waiting for a browser slot.`))
      }, this.queueTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref() // don't keep the loop alive for a waiter
      this.waiters.push({ resolve, reject, timer })
    })
  }

  // Each permit releases exactly once; a double release must never over-grant a slot.
  private makePermit(): Permit {
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.handoff()
      },
    }
  }

  // Hand the freed slot to the next waiter if any (active stays constant), else free it.
  private handoff() {
    const next = this.waiters.shift()
    if (next) {
      clearTimeout(next.timer)
      next.resolve(this.makePermit())
    } else {
      this.active--
    }
  }
}

const browserGate = new BrowserGate(MAX_BROWSER_CONCURRENCY, MAX_BROWSER_QUEUE, BROWSER_QUEUE_TIMEOUT_MS)
console.log(`Browser gate: concurrency=${MAX_BROWSER_CONCURRENCY} queue=${MAX_BROWSER_QUEUE} timeout=${BROWSER_QUEUE_TIMEOUT_MS}ms`)

// ─── Unkey Key Verification ───────────────────────────────────────────────────
interface UnkeyResult {
  valid: boolean
  ownerId?: string
  plan: string
  error?: string
  // True ONLY when the caller authenticated with the PLAYGROUND_BYPASS_KEY secret
  // (the trusted frontend proxy). Gates whether the X-Shotbase-User-Id header is
  // trusted for attribution. The root key does NOT set this.
  viaBypass?: boolean
}

async function verifyKey(apiKey: string): Promise<UnkeyResult> {
  // Playground bypass — used by the Next.js proxy route.
  // Secret value via PLAYGROUND_BYPASS_KEY (never hardcoded). UNKEY_ROOT_KEY also
  // short-circuits. If neither env var is set, there is NO bypass — fail closed.
  const rootKey = process.env.UNKEY_ROOT_KEY
  const bypassKey = process.env.PLAYGROUND_BYPASS_KEY
  // Bypass secret → trusted proxy: mark viaBypass so the caller must assert a user.
  if (bypassKey && apiKey === bypassKey) {
    return { valid: true, ownerId: 'playground', plan: 'pro', viaBypass: true }
  }
  // Root key → admin short-circuit. NOT the proxy; header is never trusted here.
  if (rootKey && apiKey === rootKey) {
    return { valid: true, ownerId: 'playground', plan: 'pro' }
  }

  // Dev fallback: static API_KEYS env var (no Unkey root key configured → can't call v2).
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
  // - Owner = identity.externalId; plan lives in the key's meta.
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
        valid?: boolean
        code?: string
        keyId?: string
        identity?: { externalId?: string }
        meta?: { plan?: string }
      }
      error?: { title?: string }
    }

    const data = body.data
    if (!data?.valid) {
      return {
        valid: false,
        plan: 'free',
        error: data?.code ?? body.error?.title ?? 'Invalid API key',
      }
    }

    return { valid: true, ownerId: data.identity?.externalId, plan: data.meta?.plan ?? 'free' }
  } catch (err) {
    console.error('Unkey verify error:', err)
    return { valid: false, plan: 'free', error: 'Key verification failed' }
  }
}

// ─── Owner Attribution ────────────────────────────────────────────────────────
// Resolve the user a capture is billed/logged to.
//  - viaBypass (trusted frontend proxy): attribute to the Clerk user id supplied in
//    the internal X-Shotbase-User-Id header. Missing/blank/malformed → FAIL CLOSED
//    (never fall back to a generic "playground" owner).
//  - Any other caller (Unkey key, static key, root key): use the key's own ownerId.
//    The header is IGNORED, so an ordinary client can't spoof another user.
// Clerk ids are opaque strings like "user_2ab…"; accept only a safe, bounded charset.
const INTERNAL_USER_HEADER = 'X-Shotbase-User-Id'
export function isValidUserId(id: string): boolean {
  return id.length >= 1 && id.length <= 255 && /^[A-Za-z0-9_-]+$/.test(id)
}
export function resolveOwner(
  keyResult: UnkeyResult,
  userIdHeader: string | undefined,
): { ok: true; ownerId: string } | { ok: false; message: string } {
  if (keyResult.viaBypass) {
    const uid = userIdHeader?.trim() ?? ''
    if (!uid || !isValidUserId(uid)) {
      // Do not echo the raw header value (avoid leaking/handling untrusted ids).
      return { ok: false, message: 'Missing or invalid internal user attribution' }
    }
    return { ok: true, ownerId: uid }
  }
  return { ok: true, ownerId: keyResult.ownerId ?? 'unknown' }
}

// ─── Canonical Plan Configuration (single source of truth) ────────────────────
// Pricing v2. Self-serve plans are exactly: free, builder, pro. Each value below
// is the FINAL public contract (captures/month, AI extractions/month, req/min).
//
// Legacy compatibility ONLY: old key/test metadata may still say "starter"/"scale".
// Those normalize to builder/pro — but the old Starter/Scale quota & rate VALUES
// are intentionally dropped. Any unknown/blank plan → free (never a high allowance).
//
// Business is sales-assisted and is NOT auto-provisioned by this self-serve code:
// no fixed Business limits are invented. A "business" plan value therefore
// normalizes to free here (lowest allowance) until sales wiring exists — it can
// never silently grant more than Free.
export type CanonicalPlan = 'free' | 'builder' | 'pro'
export interface PlanLimits { captureLimit: number; aiExtractionLimit: number; rpm: number }
export const PLAN_CONFIG: Record<CanonicalPlan, PlanLimits> = {
  free:    { captureLimit: 250,   aiExtractionLimit: 25,    rpm: 10 },
  builder: { captureLimit: 1_500, aiExtractionLimit: 150,   rpm: 20 },
  pro:     { captureLimit: 7_500, aiExtractionLimit: 1_000, rpm: 40 },
}

// Normalize any inbound plan string to a canonical self-serve plan id.
export function normalizePlan(plan: string | null | undefined): CanonicalPlan {
  switch ((plan ?? '').trim().toLowerCase()) {
    case 'pro':     return 'pro'
    case 'builder': return 'builder'
    case 'scale':   return 'pro'      // legacy → pro
    case 'starter': return 'builder'  // legacy → builder
    case 'free':    return 'free'
    default:        return 'free'      // unknown / business / blank → lowest allowance
  }
}

// ─── Plan-derived limits (all read from PLAN_CONFIG via normalizePlan) ─────────
export function getRateLimitPerMinute(plan: string): number {
  return PLAN_CONFIG[normalizePlan(plan)].rpm
}
export function getCaptureQuota(plan: string): number {
  return PLAN_CONFIG[normalizePlan(plan)].captureLimit
}
export function getAiExtractionQuota(plan: string): number {
  return PLAN_CONFIG[normalizePlan(plan)].aiExtractionLimit
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
// NOTE: ai_requested / ai_succeeded require the matching Supabase columns. That
// migration lives in the FRONTEND repo (see report). Until it lands, inserts that
// include these fields will error — but logScreenshot is fire-and-forget, so it
// only affects usage logging, never the response.
async function logScreenshot(data: {
  userId: string
  url: string
  format: string
  status: number
  timeMs: number
  sizeKb: number
  cached: boolean
  aiRequested?: boolean  // true only when an AI extraction was actually requested
  aiSucceeded?: boolean  // true only when Bedrock produced an AI result
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
      ai_requested: data.aiRequested ?? false,
      ai_succeeded: data.aiSucceeded ?? false,
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
      renderTime: number; cached: boolean; pageText: string | null; aiData?: Record<string, unknown>; aiError?: string
      timings?: Record<string, number>; fallbackUsed?: boolean
      scrollDiag?: (ScrollDiag & { error?: boolean })
      fixedOverlay?: { detected: boolean; height: number; composited: boolean; ms: number } }
  | { ok: false; kind: 'ssrf' | 'capture' | 'overloaded'; message: string; retryAfterMs?: number }

// ─── Bounded navigation strategy (render reliability) ────────────────────────────
// networkidle never settles on pages with continuous background traffic (ads,
// analytics, websockets) → a 30s timeout used to DISCARD an otherwise-rendered page.
// New strategy: wait for DOMContentLoaded (hard cap), then try networkidle only for a
// short bound; if it doesn't settle, do a deterministic short settle and proceed
// (never wait the full timeout before falling back).
const NAV_TIMEOUT_MS         = Math.max(1000, Math.floor(Number(process.env.NAV_TIMEOUT_MS ?? 30_000)) || 30_000)
const NAV_IDLE_MS            = Math.max(0, Math.floor(Number(process.env.NAV_IDLE_MS ?? 4_000)) || 4_000)
const NAV_SETTLE_FALLBACK_MS = Math.max(0, Math.floor(Number(process.env.NAV_SETTLE_FALLBACK_MS ?? 750)) || 750)

// ─── Bounded env parsing helpers (safe: NaN/out-of-range → clamped default) ───────
function envInt(name: string, def: number, min: number, max: number): number {
  const v = Math.floor(Number(process.env[name] ?? def))
  if (!Number.isFinite(v)) return def
  return Math.min(max, Math.max(min, v))
}
function envFloat(name: string, def: number, min: number, max: number): number {
  const v = Number(process.env[name] ?? def)
  if (!Number.isFinite(v)) return def
  return Math.min(max, Math.max(min, v))
}
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name]
  if (v === undefined || v === '') return def
  const s = v.trim().toLowerCase()
  return s === 'true' || s === '1' || s === 'yes'
}

// ─── Bounded full-page scroll prepass (render reliability for lazy/scroll content) ─
// Playwright's fullPage screenshot renders the whole document in one shot but does
// NOT traverse it first, so lazy images, IntersectionObserver content, and GSAP/
// ScrollTrigger reveals never fire → a full-height image with blank sections.
// For fullPage image captures we first walk the viewport downward in bounded steps
// (like a real user) so that content initializes BEFORE capture. Every knob is
// bounded so a pathological/infinite-feed page terminates deterministically.
const FULLPAGE_SCROLL_ENABLED         = envBool('FULLPAGE_SCROLL_ENABLED', true)
const FULLPAGE_SCROLL_STEP_RATIO      = envFloat('FULLPAGE_SCROLL_STEP_RATIO', 0.85, 0.1, 1.0)
const FULLPAGE_SCROLL_STEP_WAIT_MS    = envInt('FULLPAGE_SCROLL_STEP_WAIT_MS', 150, 0, 2_000)
const FULLPAGE_SCROLL_MAX_STEPS       = envInt('FULLPAGE_SCROLL_MAX_STEPS', 50, 1, 500)
const FULLPAGE_SCROLL_MAX_MS          = envInt('FULLPAGE_SCROLL_MAX_MS', 7_000, 500, 30_000)
const FULLPAGE_SCROLL_MAX_HEIGHT_PX   = envInt('FULLPAGE_SCROLL_MAX_HEIGHT_PX', 40_000, 2_000, 200_000)
const FULLPAGE_SCROLL_FINAL_SETTLE_MS = envInt('FULLPAGE_SCROLL_FINAL_SETTLE_MS', 250, 0, 5_000)

// ─── Fixed/sticky top-element preservation (full-page image captures) ─────────────
// Playwright paints position:fixed/sticky elements at the CURRENT scroll offset, so
// the leave-at-bottom full-page prepass drops the top navbar from y=0 (and could
// leave a stray copy mid-page). Generic fix: BEFORE the prepass (page at top) detect
// top-anchored fixed/sticky elements and snapshot that top strip once; hide ONLY
// those elements during the full-page shot (so nothing is duplicated); composite the
// strip back at y=0. No scroll-back-to-top (avoids the reverse/scrub blank
// regression); no permanent DOM mutation (visibility is toggled then fully restored).
const FULLPAGE_FIXED_OVERLAY_ENABLED = envBool('FULLPAGE_FIXED_OVERLAY_ENABLED', true)
// Ceiling on the overlay strip height (px). Also the max height a fixed/sticky
// element may occupy to still count as a "header" — taller ones (modals, hero
// overlays) are ignored so we never composite a full-screen layer as a navbar.
const FULLPAGE_FIXED_OVERLAY_MAX_PX  = envInt('FULLPAGE_FIXED_OVERLAY_MAX_PX', 240, 40, 2_000)

// Cache version — bump when rendered output changes so a stale (pre-fix) image
// (blank sections, or a navbar-missing full page) can't be served from cache after
// rollout. TTL is only 60s, so this just closes the brief post-rollout window; it
// invalidates every key once.
const CAPTURE_CACHE_VERSION = 'v3-fixedoverlay'

// ── Generic fixed/sticky detection + hide/restore (run in the page via evaluate) ──
// Conservative + generic: NO tag/class/id/hostname/text heuristics. An element
// qualifies only if it is computed position fixed|sticky, visible, wide (header-like),
// not too tall, and anchored to the TOP of the viewport (so bottom chat widgets /
// cookie bars are excluded). Matched elements are marked with data-sb-fixed (storing
// their original inline visibility) so hide/restore can find them deterministically.
export const DETECT_FIXED = (cap: number): { overlayHeight: number; count: number } => {
  const vw = window.innerWidth, vh = window.innerHeight
  let maxBottom = 0, count = 0
  const all = document.querySelectorAll('body *')
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as HTMLElement
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue
    if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity || '1') < 0.1) continue
    const r = el.getBoundingClientRect()
    if (r.width < vw * 0.3) continue            // must span a header-like width
    if (r.height < 8 || r.height > vh * 0.5) continue
    if (r.top > vh * 0.25) continue             // top-anchored only (excludes bottom widgets)
    if (r.bottom <= 0 || r.bottom > cap) continue // within the header band; skip tall overlays
    el.setAttribute('data-sb-fixed', el.style.visibility || '__empty__')
    if (r.bottom > maxBottom) maxBottom = r.bottom
    count++
  }
  return { overlayHeight: Math.min(Math.ceil(maxBottom), cap), count }
}
export const HIDE_FIXED = (): void => {
  const els = document.querySelectorAll('[data-sb-fixed]')
  for (let i = 0; i < els.length; i++) (els[i] as HTMLElement).style.visibility = 'hidden'
}
export const RESTORE_FIXED = (): void => {
  const els = document.querySelectorAll('[data-sb-fixed]')
  for (let i = 0; i < els.length; i++) {
    const el = els[i] as HTMLElement
    const orig = el.getAttribute('data-sb-fixed')
    el.style.visibility = (orig === '__empty__' || orig === null) ? '' : orig
    el.removeAttribute('data-sb-fixed')
  }
}

// Error-safe orchestration for the hide → full-page shot → restore → composite flow.
// Restoration ALWAYS runs (finally) even if the screenshot throws, so a capture-time
// failure never leaves the page mutated; the throw propagates so the outer handler
// releases the BrowserGate permit and reports the failure. Injectable ops make this
// unit-testable without a browser.
export interface FixedOverlayOps {
  hide: () => Promise<void>
  screenshotPng: () => Promise<Buffer>
  restore: () => Promise<void>
  composite: (base: Buffer) => Promise<Buffer>
}
export async function screenshotWithFixedOverlay(ops: FixedOverlayOps): Promise<Buffer> {
  await ops.hide()
  let base: Buffer
  try {
    base = await ops.screenshotPng()
  } finally {
    await ops.restore()
  }
  return ops.composite(base)
}

// A minimal page surface the prepass needs — lets it be unit-tested with a mock
// (real captures can't target a local test server: the SSRF guard blocks private IPs).
export interface ScrollPage {
  metrics(): Promise<{ scrollY: number; viewportHeight: number; scrollHeight: number }>
  scrollTo(y: number): Promise<void>
  wait(ms: number): Promise<void>
}
export interface ScrollPrepassOpts {
  stepRatio: number
  stepWaitMs: number
  maxSteps: number
  maxMs: number
  maxHeightPx: number
  now?: () => number
}
export interface ScrollDiag {
  ms: number
  steps: number
  initialHeight: number
  maxHeight: number
  boundHit: boolean
  boundReason: string
}
// Bounded downward traversal. Stops at the true bottom OR the first safety bound.
// Re-reads height each step so lazy/growing content is followed — but only within
// the bounds, so an infinite feed terminates. Never scrolls back up (see prepass
// call site: reverse-on-scroll reveals must not be un-triggered before capture).
export async function scrollPrepass(page: ScrollPage, opts: ScrollPrepassOpts): Promise<ScrollDiag> {
  const now = opts.now ?? Date.now
  const start = now()
  const first = await page.metrics()
  const initialHeight = first.scrollHeight
  let maxHeight = initialHeight
  const step = Math.max(1, Math.round(first.viewportHeight * opts.stepRatio))
  let steps = 0
  let boundHit = false
  let boundReason = ''
  let m = first
  while (true) {
    if (m.scrollHeight > maxHeight) maxHeight = m.scrollHeight
    // Reached the bottom of the (current) document → done, not a bound.
    if (m.scrollY + m.viewportHeight >= m.scrollHeight - 2) break
    // Safety bounds — any one terminates the traversal deterministically.
    if (steps >= opts.maxSteps)        { boundHit = true; boundReason = 'max_steps';  break }
    if (now() - start >= opts.maxMs)   { boundHit = true; boundReason = 'max_ms';     break }
    if (m.scrollHeight >= opts.maxHeightPx) { boundHit = true; boundReason = 'max_height'; break }
    const target = Math.min(m.scrollY + step, opts.maxHeightPx)
    await page.scrollTo(target)
    steps++
    if (opts.stepWaitMs > 0) await page.wait(opts.stepWaitMs)
    m = await page.metrics()
  }
  return { ms: now() - start, steps, initialHeight, maxHeight, boundHit, boundReason }
}

// Graceful wrapper around the prepass: a traversal error must NEVER fail an
// otherwise-good capture — log it safely and continue with an error-tagged diag.
// The prepass function is injectable (defaults to the real one) so tests can force
// a failure WITHOUT any production env var or runtime trigger.
export type ScrollPrepassResult = ScrollDiag & { error?: boolean }
export async function runScrollPrepass(
  page: ScrollPage,
  opts: ScrollPrepassOpts,
  prepassFn: (p: ScrollPage, o: ScrollPrepassOpts) => Promise<ScrollDiag> = scrollPrepass,
): Promise<ScrollPrepassResult> {
  const now = opts.now ?? Date.now
  const start = now()
  try {
    return await prepassFn(page, opts)
  } catch (err) {
    console.error('Scroll prepass error (continuing to capture):', err instanceof Error ? err.message : 'unknown')
    return { ms: now() - start, steps: 0, initialHeight: 0, maxHeight: 0, boundHit: false, boundReason: '', error: true }
  }
}

// Adapter: drive a real Playwright page through the ScrollPage surface.
function playwrightScrollPage(page: { evaluate: Function; waitForTimeout: Function }): ScrollPage {
  return {
    metrics: () => page.evaluate(() => ({
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
      viewportHeight: window.innerHeight,
      scrollHeight: Math.max(
        document.documentElement?.scrollHeight ?? 0,
        document.body?.scrollHeight ?? 0,
      ),
    })) as Promise<{ scrollY: number; viewportHeight: number; scrollHeight: number }>,
    scrollTo: (y: number) => page.evaluate((yy: number) => window.scrollTo(0, yy), y) as Promise<void>,
    wait: (ms: number) => page.waitForTimeout(ms) as Promise<void>,
  }
}

async function performCapture(opts: CaptureOpts): Promise<CaptureResult> {
  const { url, format, fullPage, width, height, includeText, aiExtract, ownerId } = opts
  // An ai_extract object where every value is false (or {}) is NOT an AI request:
  // don't extract text for it, don't invoke Bedrock, don't consume AI quota.
  const aiRequested = !!aiExtract && Object.values(aiExtract).some((v) => v === true)
  const startTime = Date.now()
  const timings: Record<string, number> = {}
  const mark = (k: string, from: number) => { timings[k] = Date.now() - from }

  // SSRF guard (incl. DNS resolution) — fail fast before touching the browser
  const tValidate = Date.now()
  const safe = await validateSafeUrl(url)
  mark('validationMs', tValidate)
  if (!safe.ok) return { ok: false, kind: 'ssrf', message: safe.reason }

  // Cache (image-only modes, mirrors the original handler).
  // Key MUST include every render-affecting parameter — width/height changed the
  // pixels but were previously omitted, so a 320-wide and a 1440-wide capture of
  // the same URL collided and served the wrong image.
  const cacheKey = `cache:${CAPTURE_CACHE_VERSION}:${url}:${format}:${fullPage}:${width}x${height}`
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

  // Concurrency gate — real browser work only. Cache hits / SSRF rejects above
  // never reach here, so they never consume a slot. Acquire fails cleanly (queue
  // full or wait timed out) without ever touching the browser.
  let permit: Permit
  const tQueue = Date.now()
  try {
    permit = await browserGate.acquire()
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server busy'
    logScreenshot({ userId: ownerId, url, format, status: 503, timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
    return { ok: false, kind: 'overloaded', message, retryAfterMs: BROWSER_QUEUE_TIMEOUT_MS || 1000 }
  }
  mark('queueWaitMs', tQueue)

  const b = await getBrowser()
  let context: BrowserContext | null = null
  let fallbackUsed = false
  try {
    const tCtx = Date.now()
    context = await b.newContext()
    const page = await context.newPage()
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })
    mark('contextCreateMs', tCtx)

    // ── Bounded navigation ────────────────────────────────────────────────────
    // 1) DOMContentLoaded (hard cap). A throw here IS a real navigation/capture failure.
    const tNav = Date.now()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    mark('navigationMs', tNav)
    // 2) Try to reach networkidle, but only for a short bound. If it doesn't settle,
    //    fall back to a deterministic settle delay instead of waiting the full timeout.
    const tSettle = Date.now()
    try {
      await page.waitForLoadState('networkidle', { timeout: NAV_IDLE_MS })
    } catch {
      fallbackUsed = true
      await page.waitForTimeout(NAV_SETTLE_FALLBACK_MS)
    }
    mark('settleMs', tSettle)
    // 3) Meaningful-content guard: only discard if the page produced essentially nothing.
    const hasContent = await page.evaluate(
      () => ((document.body?.innerText || '').trim().length > 0) || ((document.body?.childElementCount ?? 0) > 3)
    ).catch(() => true)
    if (!hasContent) {
      logScreenshot({ userId: ownerId, url, format, status: 500, timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
      return { ok: false, kind: 'capture', message: 'Navigation completed but page produced no content' }
    }

    // ── Fixed/sticky top-element overlay: DETECT + SNAPSHOT (page still at top) ──
    // Runs BEFORE the prepass while scrollY≈0, so the navbar is captured exactly as
    // a first-time visitor sees it. Only full-page image captures; failures are
    // non-fatal (skip the overlay, fall back to the plain full-page shot).
    let fixedOverlay: Buffer | null = null
    let fixedOverlayDetected = false
    let fixedOverlayHeight = 0
    let fixedOverlayMs = 0
    const wantFixedOverlay = fullPage && format !== 'pdf' && FULLPAGE_SCROLL_ENABLED && FULLPAGE_FIXED_OVERLAY_ENABLED
    if (wantFixedOverlay) {
      const tFix = Date.now()
      try {
        const det = await page.evaluate(DETECT_FIXED, FULLPAGE_FIXED_OVERLAY_MAX_PX)
        fixedOverlayDetected = det.count > 0
        fixedOverlayHeight = det.overlayHeight
        if (det.count > 0 && det.overlayHeight > 0) {
          fixedOverlay = Buffer.from(await page.screenshot({ clip: { x: 0, y: 0, width, height: det.overlayHeight } }))
        }
      } catch (err) {
        console.error('Fixed-overlay detect/capture error (skipping overlay):', err instanceof Error ? err.message : 'unknown')
        fixedOverlay = null
      }
      fixedOverlayMs = Date.now() - tFix
    }

    // ── Bounded full-page scroll prepass ──────────────────────────────────────
    // Only for full-page IMAGE captures (png/jpeg/webp): traverse the viewport so
    // lazy/IntersectionObserver/GSAP-reveal content initializes BEFORE capture.
    // Scoped out of PDF on purpose — page.pdf() ignores fullPage, so running it
    // there would silently redefine the PDF contract (see report). We leave the
    // page at the position reached (never scroll back to top) because reverse-on-
    // scroll reveals would otherwise un-trigger before the screenshot. A prepass
    // error degrades gracefully: log it and still capture the state reached.
    let scrollDiag: ScrollPrepassResult | undefined
    if (fullPage && FULLPAGE_SCROLL_ENABLED && format !== 'pdf') {
      // Graceful: a prepass error is logged inside runScrollPrepass and returned as
      // an error-tagged diag; the capture continues with the state reached.
      scrollDiag = await runScrollPrepass(playwrightScrollPage(page), {
        stepRatio: FULLPAGE_SCROLL_STEP_RATIO,
        stepWaitMs: FULLPAGE_SCROLL_STEP_WAIT_MS,
        maxSteps: FULLPAGE_SCROLL_MAX_STEPS,
        maxMs: FULLPAGE_SCROLL_MAX_MS,
        maxHeightPx: FULLPAGE_SCROLL_MAX_HEIGHT_PX,
      })
      // Optional short final settle so the last-revealed section / images finish.
      if (FULLPAGE_SCROLL_FINAL_SETTLE_MS > 0) await page.waitForTimeout(FULLPAGE_SCROLL_FINAL_SETTLE_MS).catch(() => {})
      timings.fullPageScrollMs        = scrollDiag.ms
      timings.fullPageScrollSteps     = scrollDiag.steps
      timings.fullPageInitialHeight   = scrollDiag.initialHeight
      timings.fullPageMaxHeight       = scrollDiag.maxHeight
      timings.fullPageScrollBoundHit  = scrollDiag.boundHit ? 1 : 0
      if (scrollDiag.error) timings.fullPageScrollError = 1
      console.log(`[fullpage] steps=${scrollDiag.steps} initH=${scrollDiag.initialHeight} maxH=${scrollDiag.maxHeight} boundHit=${scrollDiag.boundHit}${scrollDiag.boundReason ? '(' + scrollDiag.boundReason + ')' : ''} ms=${scrollDiag.ms}${scrollDiag.error ? ' error=1' : ''}`)
    }

    // Text extraction runs AFTER the prepass so lazy-inserted text is included.
    const tText = Date.now()
    let pageText: string | null = null
    if (includeText || aiRequested) {
      try {
        pageText = await page.evaluate(() => document.body.innerText)
        pageText = pageText?.replace(/\n\s*\n/g, '\n\n').trim() ?? null
      } catch (err) {
        pageText = `extraction failed: ${err instanceof Error ? err.message : 'unknown'}`
      }
    }
    mark('pageTextMs', tText)

    const tShot = Date.now()
    let buffer: Buffer
    let contentType: string
    let fixedOverlayComposited = false
    if (format === 'pdf') {
      buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
      contentType = 'application/pdf'
    } else if (fixedOverlay) {
      // Full-page image with a captured top overlay: hide the detected fixed/sticky
      // elements for the shot (no stray/duplicate copy at the bottom), take the
      // full-page PNG, restore, then composite the overlay strip back at y=0. Both
      // images are the same width at DPR 1, so the composite aligns pixel-for-pixel.
      const overlay = fixedOverlay
      const tFixComposite = Date.now()
      buffer = await screenshotWithFixedOverlay({
        hide: () => page.evaluate(HIDE_FIXED),
        screenshotPng: async () => Buffer.from(await page.screenshot({ type: 'png', fullPage: true })),
        restore: () => page.evaluate(RESTORE_FIXED),
        composite: async (base) => {
          const img = sharp(base).composite([{ input: overlay, top: 0, left: 0 }])
          if (format === 'jpeg') return img.jpeg({ quality: 80 }).toBuffer()
          if (format === 'webp') return img.webp().toBuffer()
          return img.png().toBuffer()
        },
      })
      contentType = getContentType(format)
      fixedOverlayComposited = true
      fixedOverlayMs += Date.now() - tFixComposite
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
    mark('screenshotMs', tShot)
    // Fixed-overlay observability (internal; additive timings + narrow header/JSON).
    if (wantFixedOverlay) {
      timings.fixedOverlayDetected   = fixedOverlayDetected ? 1 : 0
      timings.fixedOverlayHeight     = fixedOverlayHeight
      timings.fixedOverlayComposited = fixedOverlayComposited ? 1 : 0
      timings.fixedOverlayMs         = fixedOverlayMs
      console.log(`[fixedoverlay] detected=${fixedOverlayDetected} height=${fixedOverlayHeight} composited=${fixedOverlayComposited} ms=${fixedOverlayMs}`)
    }

    // AI extraction — a Bedrock failure is reported via aiError; the image stays valid.
    const tBedrock = Date.now()
    let aiData: Record<string, unknown> | undefined
    let aiError: string | undefined
    if (aiRequested && aiExtract && bedrockClient && pageText) {
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

    mark('bedrockMs', tBedrock)
    // ai_succeeded is true ONLY when Bedrock produced an AI result. A Bedrock
    // failure (graceful degradation → aiData undefined + aiError) stays false.
    const aiSucceeded = aiRequested && aiData !== undefined
    const renderTime = Date.now() - startTime
    timings.totalMs = renderTime
    if (redis) {
      try { await redis.setex(cacheKey, 60, buffer.toString('base64')) } catch {}
    } else {
      cacheMap.set(cacheKey, { buffer, format, timestamp: now })
    }
    logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: renderTime, sizeKb: buffer.length / 1024, cached: false, aiRequested, aiSucceeded })

    return { ok: true, buffer, contentType, format, width, height, renderTime, cached: false, pageText, aiData, aiError, timings, fallbackUsed, scrollDiag,
      fixedOverlay: wantFixedOverlay ? { detected: fixedOverlayDetected, height: fixedOverlayHeight, composited: fixedOverlayComposited, ms: fixedOverlayMs } : undefined }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('Screenshot error:', msg)
    logScreenshot({ userId: ownerId, url, format, status: 500, timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
    return { ok: false, kind: 'capture', message: msg }
  } finally {
    if (context) await context.close().catch(() => {})
    permit.release() // ALWAYS — success, capture error, or browser crash/relaunch
  }
}

// Client-facing message for any AI-extraction failure. The full provider error
// (which can carry AWS account state, IAM/ARN details, or other internals) is
// logged server-side only — never returned to the caller.
const AI_EXTRACT_UNAVAILABLE_MSG = 'AI extraction temporarily unavailable'

// ─── Body-size protection (Phase B) ─────────────────────────────────────────────
// Reject oversized/malformed-oversized requests before any browser or AI work, so a
// giant payload can't exhaust memory. bodyLimit checks Content-Length and streams
// with a hard cap; onError fires before the route handler runs.
const MAX_BODY_BYTES = Math.max(1024, Math.floor(Number(process.env.MAX_BODY_BYTES ?? 1_048_576)) || 1_048_576)
const screenshotBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) => c.json({ error: 'Request body too large', detail: `Max ${MAX_BODY_BYTES} bytes` }, 413),
})
const mcpBodyLimit = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  // Body never parsed → no JSON-RPC id to echo; use id:null per JSON-RPC.
  onError: (c) => c.json(rpcError(null, -32600, 'Request too large'), 413),
})

// ─── Monthly Quota Enforcement (Phase C — Pricing v2, dual quota) ────────────────
// Per-plan monthly caps enforced at the backend for REST, MCP, and playground.
// TWO independent quotas per the pricing contract:
//   • captures       — every SUCCESSFUL served capture (status 200, incl. cache hits)
//   • ai_extractions — every SUCCESSFUL AI extraction (status 200 AND ai_succeeded)
// Enforcement is Supabase-backed: when Supabase is not configured at all, quota is
// DISABLED by design (dev/self-host). When it IS configured but a required query
// fails, we FAIL CLOSED (never silently allow unlimited).
function startOfMonthUtcIso(): string {
  const n = new Date()
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1)).toISOString()
}
// Count this user's SUCCESSFUL captures in the current UTC month. Only status=200
// rows count (auth/validation/SSRF/render/queue failures are logged but excluded);
// cache hits DO count (they are served, status=200). Returns null on query error
// (→ fail closed).
async function getMonthlyUsage(userId: string): Promise<number | null> {
  if (!supabase) return null
  try {
    const { count, error } = await supabase
      .from('screenshots')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 200)
      .gte('created_at', startOfMonthUtcIso())
    if (error) { console.error('Quota usage query error:', error.message); return null }
    return count ?? 0
  } catch (err) {
    console.error('Quota usage query threw:', err instanceof Error ? err.message : 'unknown')
    return null
  }
}
// Count this user's SUCCESSFUL AI extractions in the current UTC month:
// status=200 AND ai_succeeded=true. Returns null on query error (→ fail closed).
async function getMonthlyAiUsage(userId: string): Promise<number | null> {
  if (!supabase) return null
  try {
    const { count, error } = await supabase
      .from('screenshots')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('status', 200)
      .eq('ai_succeeded', true)
      .gte('created_at', startOfMonthUtcIso())
    if (error) { console.error('AI quota usage query error:', error.message); return null }
    return count ?? 0
  } catch (err) {
    console.error('AI quota usage query threw:', err instanceof Error ? err.message : 'unknown')
    return null
  }
}
// The real plan for a playground (bypass) user lives in Supabase users.plan.
// Returns null on error/not-found (→ fail closed).
async function getUserPlan(userId: string): Promise<string | null> {
  if (!supabase) return null
  try {
    const { data, error } = await supabase.from('users').select('plan').eq('clerk_id', userId).single()
    if (error || !data?.plan) { if (error) console.error('User plan query error:', error.message); return null }
    return data.plan as string
  } catch (err) {
    console.error('User plan query threw:', err instanceof Error ? err.message : 'unknown')
    return null
  }
}

// Resolve the effective, normalized plan to enforce for BOTH rate limiting and
// monthly quotas. The trusted playground (bypass) key authenticates as a generic
// 'pro' placeholder, so its REAL plan must be read from Supabase users.plan BEFORE
// any user-facing limit is applied — otherwise a Free user coming through the
// playground would inherit the placeholder's higher rate. Any other caller uses
// its own key plan (the X-Shotbase-User-Id header is never trusted for plan).
// Fails closed when accounting is configured but the plan lookup fails.
type PlanResolution = { ok: true; plan: CanonicalPlan } | { ok: false; kind: 'accounting' }
async function resolveEffectivePlan(keyResult: UnkeyResult, ownerId: string): Promise<PlanResolution> {
  if (keyResult.viaBypass && supabase) {
    const real = await getUserPlan(ownerId)
    if (real === null) return { ok: false, kind: 'accounting' }
    return { ok: true, plan: normalizePlan(real) }
  }
  return { ok: true, plan: normalizePlan(keyResult.plan) }
}

type QuotaResult =
  | { ok: true }
  | { ok: false; kind: 'quota'; quotaType: 'captures' | 'ai_extractions'; plan: CanonicalPlan; limit: number; used: number }
  | { ok: false; kind: 'accounting' }
// Enforce the monthly caps for an already-resolved effective plan. Capture quota is
// always checked; the AI-extraction quota only when the request actually asks for AI
// (aiRequested). Capture-exhausted takes precedence over AI-exhausted. Any required
// count query failing → accounting failure (fail closed). No-op when Supabase unset.
// NOTE: non-atomic (count → serve → fire-and-forget log), so concurrent requests at
// the boundary can overshoot by up to the number of in-flight captures.
async function checkMonthlyQuota(plan: CanonicalPlan, ownerId: string, aiRequested: boolean): Promise<QuotaResult> {
  if (!supabase) return { ok: true } // quota disabled (no accounting backend)

  const captureUsage = await getMonthlyUsage(ownerId)
  if (captureUsage === null) return { ok: false, kind: 'accounting' } // configured but query failed → fail closed
  const captureLimit = getCaptureQuota(plan)
  if (captureUsage >= captureLimit) {
    return { ok: false, kind: 'quota', quotaType: 'captures', plan, limit: captureLimit, used: captureUsage }
  }

  if (aiRequested) {
    const aiUsage = await getMonthlyAiUsage(ownerId)
    if (aiUsage === null) return { ok: false, kind: 'accounting' }
    const aiLimit = getAiExtractionQuota(plan)
    if (aiUsage >= aiLimit) {
      return { ok: false, kind: 'quota', quotaType: 'ai_extractions', plan, limit: aiLimit, used: aiUsage }
    }
  }
  return { ok: true }
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
    browserActive: browserGate.activeCount,
    browserQueued: browserGate.queuedCount,
  })
)

app.post('/screenshot', screenshotBodyLimit, async (c) => {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authorization = c.req.header('Authorization')
  if (!authorization) return c.json({ error: 'Missing Authorization header' }, 401)

  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) return c.json({ error: 'Invalid authorization format. Use: Bearer <key>' }, 401)

  const keyResult = await verifyKey(apiKey)
  if (!keyResult.valid) return c.json({ error: keyResult.error ?? 'Invalid API key' }, 401)

  // Attribute to the real user. Bypass callers MUST assert a valid user id or we
  // fail closed (never log as generic "playground"). Non-bypass keys ignore the header.
  const owner = resolveOwner(keyResult, c.req.header(INTERNAL_USER_HEADER))
  if (!owner.ok) return c.json({ error: owner.message }, 401)
  const ownerId = owner.ownerId

  // ── Effective plan ──────────────────────────────────────────────────────────
  // Resolve the REAL, normalized plan before any user-facing limit. For a
  // playground bypass caller this reads Supabase users.plan (so a Free user via the
  // playground is rate-limited/quota'd as Free, not as the bypass's 'pro' placeholder).
  // Configured-but-unresolvable → fail closed. Supabase unset → normalized key plan.
  const effective = await resolveEffectivePlan(keyResult, ownerId)
  if (!effective.ok) return c.json({ error: 'Usage temporarily unavailable' }, 503)
  const plan = effective.plan

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

  // ── Validate inputs ─────────────────────────────────────────────────────────
  // Backend stands alone (direct callers + MCP bypass the frontend's zod schema).
  // Bounds mirror the frontend lib/validation.ts where they overlap; the 1440×900
  // viewport defaults are the backend's existing contract and are intentionally kept.
  const url = body?.url
  if (typeof url !== 'string' || !url.trim()) {
    return c.json({ error: 'Missing or invalid "url" field' }, 400)
  }
  if (url.length > 2048) {
    return c.json({ error: '"url" exceeds the 2048-character limit' }, 400)
  }

  const format = (body?.format ?? 'png') as string
  if (!['png', 'jpeg', 'webp', 'pdf'].includes(format)) {
    return c.json({ error: 'Invalid "format" — must be one of: png, jpeg, webp, pdf' }, 400)
  }

  const fullPage = body?.full_page ?? false
  if (typeof fullPage !== 'boolean') {
    return c.json({ error: '"full_page" must be a boolean' }, 400)
  }

  const includeText = body?.include_text ?? false
  if (typeof includeText !== 'boolean') {
    return c.json({ error: '"include_text" must be a boolean' }, 400)
  }

  // Viewport — must be integers inside safe render bounds (prevents overflow /
  // pathological allocations). Defaults preserve prior behavior.
  const width = (body?.width ?? 1440) as number
  if (!Number.isInteger(width) || width < 100 || width > 3840) {
    return c.json({ error: '"width" must be an integer between 100 and 3840' }, 400)
  }
  const height = (body?.height ?? 900) as number
  if (!Number.isInteger(height) || height < 100 || height > 2160) {
    return c.json({ error: '"height" must be an integer between 100 and 2160' }, 400)
  }

  // ai_extract — a plain object of boolean flags, field-count capped (B6). Reject
  // arrays, null, non-objects, or non-boolean values rather than coercing silently.
  let aiExtract: Record<string, boolean> | undefined
  const rawExtract = body?.ai_extract
  if (rawExtract !== undefined && rawExtract !== null) {
    if (typeof rawExtract !== 'object' || Array.isArray(rawExtract)) {
      return c.json({ error: '"ai_extract" must be an object of boolean flags' }, 400)
    }
    const entries = Object.entries(rawExtract as Record<string, unknown>)
    if (entries.length > 20) {
      return c.json({ error: '"ai_extract" has too many fields (max 20)' }, 400)
    }
    for (const [k, v] of entries) {
      if (typeof v !== 'boolean') {
        return c.json({ error: `"ai_extract.${k}" must be a boolean` }, 400)
      }
    }
    aiExtract = rawExtract as Record<string, boolean>
  }

  // An ai_extract with at least one true flag is a real AI request; {} or all-false
  // is NOT (→ no Bedrock, no AI quota — treated like a plain capture).
  const aiRequested = !!aiExtract && Object.values(aiExtract).some((v) => v === true)

  if (aiRequested && !bedrockClient) {
    return c.json({ error: 'AI extraction requires AWS Bedrock credentials on the server' }, 400)
  }

  // ── Monthly quota (dual: captures + AI extractions) ──────────────────────────
  const quota = await checkMonthlyQuota(plan, ownerId, aiRequested)
  if (!quota.ok) {
    if (quota.kind === 'quota') {
      const isAi = quota.quotaType === 'ai_extractions'
      return c.json(
        {
          error: isAi ? 'Monthly AI extraction quota exceeded' : 'Monthly capture quota exceeded',
          quota_type: quota.quotaType,
          limit: quota.limit,
          used: quota.used,
        },
        429,
      )
    }
    return c.json({ error: 'Usage temporarily unavailable' }, 503) // accounting dependency failed → fail closed
  }

  // ── Capture (shared core) ──────────────────────────────────────────────────
  const r = await performCapture({ url, format, fullPage, width, height, includeText, aiExtract, ownerId })
  if (!r.ok) {
    if (r.kind === 'ssrf') return c.json({ error: 'Blocked URL', detail: r.message }, 400)
    if (r.kind === 'overloaded') {
      return c.json(
        { error: 'Server busy', detail: r.message },
        503,
        { 'Retry-After': String(Math.ceil((r.retryAfterMs ?? 1000) / 1000)) },
      )
    }
    return c.json({ error: 'Screenshot failed', detail: r.message }, 500)
  }
  // Preserve existing behavior: a Bedrock failure during ai_extract is a 500.
  // JSON response for text/AI modes. A Bedrock failure no longer discards the
  // successful render (Option B): return 200 with ai_data:null + a generic
  // ai_error, mirroring MCP's graceful degradation. The raw provider error is
  // logged server-side only (performCapture) and never returned to the client.
  if (includeText || aiRequested) {
    return c.json({
      screenshot_url: null,
      format: r.format,
      width: r.width,
      height: r.height,
      render_time_ms: r.renderTime,
      cached: r.cached,
      text: includeText ? r.pageText : undefined,
      ai_data: aiRequested ? (r.aiData ?? null) : undefined,
      ai_error: (aiRequested && r.aiError) ? AI_EXTRACT_UNAVAILABLE_MSG : undefined,
      fallback_used: r.fallbackUsed ?? false,
      timings: r.timings,
    })
  }

  if (r.cached) {
    return c.body(new Uint8Array(r.buffer), 200, { 'Content-Type': r.contentType, 'X-Cache': 'HIT' })
  }
  const imgHeaders: Record<string, string> = {
    'Content-Type': r.contentType,
    'X-Cache': 'MISS',
    'X-Render-Time': String(r.renderTime),
    'X-Nav-Fallback': String(r.fallbackUsed ?? false),
  }
  // Additive full-page scroll diagnostics (only present when the prepass ran).
  if (r.scrollDiag) {
    imgHeaders['X-FullPage-Scroll-Steps']  = String(r.scrollDiag.steps)
    imgHeaders['X-FullPage-Scroll-Ms']     = String(r.scrollDiag.ms)
    imgHeaders['X-FullPage-Initial-Height'] = String(r.scrollDiag.initialHeight)
    imgHeaders['X-FullPage-Max-Height']    = String(r.scrollDiag.maxHeight)
    imgHeaders['X-FullPage-Bound-Hit']     = String(r.scrollDiag.boundHit)
  }
  if (r.fixedOverlay) {
    imgHeaders['X-FullPage-Fixed-Detected']   = String(r.fixedOverlay.detected)
    imgHeaders['X-FullPage-Fixed-Height']     = String(r.fixedOverlay.height)
    imgHeaders['X-FullPage-Fixed-Composited'] = String(r.fixedOverlay.composited)
  }
  return c.body(new Uint8Array(r.buffer), 200, imgHeaders)
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

app.post('/api/mcp', mcpBodyLimit, async (c) => {
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

      // Attribution — same rule as /screenshot. Real API keys use their own ownerId
      // (header ignored → no spoofing); a bypass caller must assert a valid user id.
      const owner = resolveOwner(keyResult, c.req.header(INTERNAL_USER_HEADER))
      if (!owner.ok) {
        return c.json(rpcError(id, -32001, 'unauthorized'), 200)
      }

      // Effective plan — real plan for playground bypass (fail closed if unresolved),
      // so RPM + quotas use the true plan, never the bypass's 'pro' placeholder.
      const effective = await resolveEffectivePlan(keyResult, owner.ownerId)
      if (!effective.ok) {
        return c.json(rpcResult(id, { content: [{ type: 'text', text: 'Usage temporarily unavailable' }], isError: true }))
      }
      const plan = effective.plan

      // Rate limit — same per-plan buckets as /screenshot (effective plan).
      if (await checkRateLimit(apiKey, plan)) {
        const limit = getRateLimitPerMinute(plan)
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text: `Rate limit exceeded. ${plan} plan allows ${limit} requests/minute.` }],
          isError: true,
        }))
      }

      // extract=true (default) needs BOTH capture + AI quota; extract=false only capture.
      const extract  = args.extract !== false // default true

      // Monthly quota — dual (captures always; AI extractions only when extract=true).
      const quota = await checkMonthlyQuota(plan, owner.ownerId, extract)
      if (!quota.ok) {
        let text: string
        if (quota.kind === 'quota') {
          text = quota.quotaType === 'ai_extractions'
            ? `Monthly AI extraction quota exceeded. ${quota.plan} plan allows ${quota.limit} AI extractions/month (used ${quota.used}).`
            : `Monthly capture quota exceeded. ${quota.plan} plan allows ${quota.limit} captures/month (used ${quota.used}).`
        } else {
          text = 'Usage temporarily unavailable'
        }
        return c.json(rpcResult(id, { content: [{ type: 'text', text }], isError: true }))
      }

      const viewport = (args.viewport ?? {}) as { width?: number; height?: number }
      const r = await performCapture({
        url,
        format: typeof args.format === 'string' ? args.format : 'png',
        fullPage: args.full_page === true,
        width: typeof viewport.width === 'number' ? viewport.width : 1440,
        height: typeof viewport.height === 'number' ? viewport.height : 900,
        includeText: false,
        aiExtract: extract ? { page_type: true, headings: true, ctas: true, prices: true } : undefined,
        ownerId: owner.ownerId,
      })

      if (!r.ok) {
        const text = r.kind === 'ssrf' ? `Blocked URL: ${r.message}`
          : r.kind === 'overloaded' ? `Server busy: ${r.message}`
          : `Capture failed: ${r.message}`
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text }],
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
          // Generic marker only — the raw provider error (r.aiError) is logged server-side, never returned.
          content.push({ type: 'text', text: `extraction_unavailable: ${AI_EXTRACT_UNAVAILABLE_MSG}` })
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
// Only bind the port when run directly. Importing this module (e.g. from a unit
// test for BrowserGate) must not start a listener.
if (require.main === module) {
  const port = Number(process.env.PORT ?? 3000)
  console.log(`Shotbase starting on port ${port}`)
  serve({ fetch: app.fetch, port })
}
