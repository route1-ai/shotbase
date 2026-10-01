// Shotbase — AI-Native Screenshot API
// Copyright 2026 Manish Gudimetla. Licensed under AGPL-3.0. See LICENSE.

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { chromium, Browser, BrowserContext } from 'playwright'
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright'
import sharp from 'sharp'
import Redis from 'ioredis'
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { lookup } from 'node:dns/promises'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

const app = new Hono()

// ─── Redis ────────────────────────────────────────────────────────────────────
let redis: Redis | null = null
const cacheMap = new Map<string, { buffer: Buffer; format: string; timestamp: number }>()
// Data-mode (text / ai_extract JSON) results are cached separately from images.
const dataCacheMap = new Map<string, { pageText: string | null; aiData?: Record<string, unknown>; aiError?: string; timestamp: number }>()
const CACHE_TTL_MS = 60 * 1000
// The in-memory maps (used only when Redis is absent) have no TTL and no eviction of
// their own, so without a bound they grow without limit on the fallback path. Cap the
// number of live entries; boundedCacheSet evicts oldest-first once the cap is hit.
const MAX_MEMORY_CACHE_ENTRIES = 500

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
let browserLaunch: Promise<Browser> | null = null

// Concurrency-safe: dedupe overlapping launches (e.g. startup warmup + a /health
// probe) so we never spin up two Chromium instances.
async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser
  if (!browserLaunch) {
    console.log('Launching browser...')
    browserLaunch = chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    }).then((b) => {
      browser = b
      browserLaunch = null
      console.log('✓ Browser ready')
      return b
    }).catch((err) => {
      browserLaunch = null
      throw err
    })
  }
  return browserLaunch
}

// Warm up on startup (only when run as the entrypoint — not when imported by tests).
if (require.main === module) {
  getBrowser().catch((err) => console.error('Browser warmup failed:', err))
}

// ─── Request-blocking engines (@ghostery/adblocker-playwright) ────────────────────
// Two independent engines, each built ONCE at startup and enabled per-request only
// when the caller asks (block_ads / remove_popups). Engines load from BUNDLED
// serialized snapshots on disk (lists/*.bin — regenerate with
// scripts/build-blocklists.mjs); the network is used ONLY as a fallback so a boot
// with no network still works. A failed engine stays null and the capture proceeds
// WITHOUT blocking — a blocker must never fail a request.
//  • adBlocker    → ghostery prebuilt ads+tracking (lists/ads-and-tracking.bin).
//  • popupBlocker → EasyList Cookie List + Fanboy's Annoyance List (lists/popups.bin).
let adBlocker: PlaywrightBlocker | null = null
let popupBlocker: PlaywrightBlocker | null = null
const LISTS_DIR = path.join(__dirname, '..', 'lists')
const POPUP_FILTER_LISTS = [
  'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', // EasyList Cookie List (Fanboy's Cookiemonster)
  'https://secure.fanboy.co.nz/fanboy-annoyance.txt',     // Fanboy's Annoyance List
]
async function loadBlocker(
  label: string,
  snapshotFile: string,
  fromNetwork: () => Promise<PlaywrightBlocker>,
): Promise<PlaywrightBlocker | null> {
  const snapshot = path.join(LISTS_DIR, snapshotFile)
  try {
    if (existsSync(snapshot)) {
      const engine = PlaywrightBlocker.deserialize(new Uint8Array(readFileSync(snapshot)))
      console.log(`✓ ${label} blocker: ready (bundled ${snapshotFile})`)
      return engine
    }
    console.warn(`${label} blocker: bundled ${snapshotFile} missing — trying network`)
  } catch (err) {
    console.warn(`${label} blocker: bundled ${snapshotFile} unreadable (${err instanceof Error ? err.message : 'unknown'}) — trying network`)
  }
  try {
    const engine = await fromNetwork()
    console.log(`✓ ${label} blocker: ready (network fallback)`)
    return engine
  } catch (err) {
    console.error(`✗ ${label} blocker: failed (${err instanceof Error ? err.message : 'unknown'}) — captures will not ${label === 'ad/tracker' ? 'block ads' : 'filter popups'}`)
    return null
  }
}
async function initBlockers(): Promise<void> {
  adBlocker = await loadBlocker('ad/tracker', 'ads-and-tracking.bin', () => PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch))
  popupBlocker = await loadBlocker('popup/cookie', 'popups.bin', () => PlaywrightBlocker.fromLists(fetch, POPUP_FILTER_LISTS))
}
if (require.main === module) {
  initBlockers().catch((err) => console.error('Blocker init failed:', err))
}

// ─── Browser Concurrency Gate ───────────────────────────────────────────────────
// The browser is a singleton; unbounded simultaneous contexts exhaust CPU/RAM and
// crash the process. This in-process gate caps active captures, queues a bounded
// number of overflow requests, and rejects cleanly past that — no external infra.
const MAX_BROWSER_CONCURRENCY  = Math.max(1, Math.floor(Number(process.env.MAX_BROWSER_CONCURRENCY ?? 4)) || 4)
const MAX_BROWSER_QUEUE        = Math.max(0, Math.floor(Number(process.env.MAX_BROWSER_QUEUE ?? 20)) || 0)
const BROWSER_QUEUE_TIMEOUT_MS = Math.max(0, Math.floor(Number(process.env.BROWSER_QUEUE_TIMEOUT_MS ?? 10_000)) || 0)

// TEST-ONLY gate occupier (see POST /__gate/occupy). Lets a load test hold browser-gate
// slots for a bounded time so overflow behaviour is deterministic, WITHOUT capturing
// anything or touching the SSRF guard. Enabled ONLY when SHOTBASE_TEST_GATE_OCCUPY=1;
// with the var unset the route is never registered (it does not exist, not a 404 handler).
// A stray value in production is a HARD BOOT FAILURE, never a silent hole: a test lever
// that can tie up the browser gate must not survive into a real deploy.
if (process.env.SHOTBASE_TEST_GATE_OCCUPY != null && process.env.NODE_ENV === 'production') {
  console.error('FATAL: SHOTBASE_TEST_GATE_OCCUPY is a test-only lever and must never be set with NODE_ENV=production. Refusing to start.')
  process.exit(1)
}
const GATE_OCCUPY_ENABLED = process.env.SHOTBASE_TEST_GATE_OCCUPY === '1'

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

// Rate limit is keyed on `bucketKey` — the API key for direct callers, or the
// resolved user id for playground (bypass) callers, so one playground user cannot
// exhaust the shared bypass key's bucket and lock out everyone else. Runs BEFORE any
// Supabase query so a flood of rejected requests never reaches the database.
async function checkRateLimit(bucketKey: string, plan: string, limitOverride?: number): Promise<boolean> {
  const limit = limitOverride ?? getRateLimitPerMinute(plan)
  const now = Date.now()

  if (redis) {
    try {
      const key = `ratelimit:${bucketKey}`
      const count = await redis.incr(key)
      if (count === 1) await redis.expire(key, 60)
      return count > limit
    } catch (err) {
      console.error('Redis rate limit error, falling back to memory:', err)
    }
  }

  // In-memory fallback
  const entry = inMemoryRateLimit.get(bucketKey)
  if (!entry || now >= entry.reset) {
    inMemoryRateLimit.set(bucketKey, { count: 1, reset: now + 60_000 })
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

// Failure kind distinguishes a genuine resolve-failure ('dns' → the caller typo'd a
// domain → dns_failed/400) from a security refusal ('blocked' → scheme, credentials,
// internal hostname, or a public name resolving into private space → blocked_url/400).
// They MUST stay distinct: a private-IP block should read as a security refusal, never
// as "domain not found".
async function validateSafeUrl(raw: string): Promise<{ ok: true } | { ok: false; kind: 'dns' | 'blocked'; reason: string }> {
  let u: URL
  try { u = new URL(raw) } catch { return { ok: false, kind: 'blocked', reason: 'Malformed URL' } }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, kind: 'blocked', reason: `Unsupported scheme "${u.protocol}" — only http/https` }
  }
  if (u.username || u.password) return { ok: false, kind: 'blocked', reason: 'URLs with embedded credentials are not allowed' }

  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.cluster.local')) {
    return { ok: false, kind: 'blocked', reason: `Blocked internal hostname "${host}"` }
  }
  // IP literal in the host → check directly
  const literal = host.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    if (isPrivateIp(literal)) return { ok: false, kind: 'blocked', reason: `Blocked private/reserved IP "${literal}"` }
    return { ok: true }
  }
  // Hostname → resolve and check EVERY address (defends against DNS pointing at private space)
  try {
    const addrs = await lookup(host, { all: true })
    if (addrs.length === 0) return { ok: false, kind: 'dns', reason: `Hostname "${host}" did not resolve` }
    for (const { address } of addrs) {
      if (isPrivateIp(address)) return { ok: false, kind: 'blocked', reason: `Hostname "${host}" resolves to private IP ${address}` }
    }
  } catch {
    return { ok: false, kind: 'dns', reason: `Could not resolve hostname "${host}"` }
  }
  return { ok: true }
}

// ─── Core capture (shared by /screenshot and /api/mcp — wrap, don't rebuild) ───
type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit'
interface CaptureOpts {
  url: string
  format: string
  fullPage: boolean
  width: number
  height: number
  includeText: boolean
  aiExtract?: Record<string, boolean>
  ownerId: string
  // Render controls (all optional with safe defaults; validated at the route)
  waitUntil?: WaitUntil        // undefined = default strategy (load + short networkidle)
  delayMs?: number             // extra settle after navigation, 0–10000
  blockAds?: boolean           // enable the ads/tracker blocker engine
  removePopups?: boolean       // enable the cookie/annoyance blocker + DOM cleanup
  darkMode?: boolean           // colorScheme 'dark' on the context
  deviceScaleFactor?: number   // 1–3, passed to newContext
  captureImage?: boolean       // false → data mode (skip the screenshot entirely)
  skipAi?: boolean             // AI requested but monthly quota exhausted → skip Bedrock, still serve the capture/text
  // Per-viewer auth material for the TARGET page. NOT populated by any route today
  // (cookie/header passthrough isn't shipped) — declared now so the cache guard
  // exists the day it is. Any of these makes the render viewer-specific, so
  // carriesTargetAuthMaterial() forces a cache bypass (see the cache-key comment).
  cookies?: unknown                     // cookies injected into the target context
  extraHeaders?: Record<string, string> // custom request headers sent to the target
  targetAuthorization?: string          // an Authorization value meant for the TARGET page
}
// Stable, machine-readable failure codes for a page that can't be rendered. The
// frontend branches on `code`, never on the message text. Each maps to a fixed HTTP
// status. Messages are built to be genuinely useful to a developer (they include the
// caller's own hostname — that's their input, not a leak); the raw Playwright error is
// logged server-side only, never returned.
type CaptureFailCode = 'dns_failed' | 'connection_refused' | 'navigation_timeout' | 'ssl_error' | 'render_failed'
export const CAPTURE_FAIL_STATUS = {
  dns_failed: 400,          // domain doesn't resolve → caller typo
  connection_refused: 502,  // resolved, but the host refused/reset the connection
  navigation_timeout: 504,  // the page never finished loading within NAV_TIMEOUT_MS
  ssl_error: 502,           // invalid / expired TLS certificate
  render_failed: 500,       // anything else that prevented a usable render
} as const satisfies Record<CaptureFailCode, number>
export function captureFailMessage(code: CaptureFailCode, host: string): string {
  switch (code) {
    case 'dns_failed':         return `Domain not found: ${host}`
    case 'connection_refused': return `Could not connect to ${host} — the server refused the connection`
    case 'navigation_timeout': return `Timed out loading ${host}`
    case 'ssl_error':          return `${host} has an invalid or expired SSL certificate`
    case 'render_failed':      return `The page at ${host} could not be rendered`
  }
}
// Classify a raw Playwright/Chromium navigation error into a stable code. Exported so it
// can be unit-tested against the exact error strings without needing to trigger real
// network failures (which can't be produced deterministically against a local target).
export function classifyCaptureError(err: unknown): CaptureFailCode {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return 'dns_failed'
  if (/ERR_CERT|ERR_SSL|SSL_VERSION|ERR_BAD_SSL/i.test(msg)) return 'ssl_error'
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_CONNECTION_FAILED|ERR_ADDRESS_UNREACHABLE|ERR_EMPTY_RESPONSE|ERR_SOCKET_NOT_CONNECTED/i.test(msg)) return 'connection_refused'
  if (/Timeout.*exceeded|TimeoutError/i.test(msg)) return 'navigation_timeout'
  return 'render_failed'
}
function hostOf(rawUrl: string): string {
  try { return new URL(rawUrl).host } catch { return rawUrl }
}

type CaptureResult =
  | { ok: true; buffer: Buffer; contentType: string; format: string; width: number; height: number
      renderTime: number; cached: boolean; pageText: string | null; aiData?: Record<string, unknown>; aiError?: string
      timings?: Record<string, number>; fallbackUsed?: boolean; pageStatus?: number | null
      scrollDiag?: (ScrollDiag & { error?: boolean })
      fixedOverlay?: { detected: boolean; height: number; composited: boolean; ms: number } }
  | { ok: false; kind: 'ssrf'; message: string }
  | { ok: false; kind: 'overloaded'; message: string; retryAfterMs?: number }
  | { ok: false; kind: 'capture'; code: CaptureFailCode; message: string }

// ─── Bounded navigation strategy (render reliability) ────────────────────────────
// networkidle never settles on pages with continuous background traffic (ads,
// analytics, websockets) → a 30s timeout used to DISCARD an otherwise-rendered page.
// New strategy: wait for DOMContentLoaded (hard cap), then try networkidle only for a
// short bound; if it doesn't settle, do a deterministic short settle and proceed
// (never wait the full timeout before falling back).
const NAV_TIMEOUT_MS          = Math.max(1000, Math.floor(Number(process.env.NAV_TIMEOUT_MS ?? 30_000)) || 30_000)
// Short networkidle bound used with the DEFAULT strategy (goto 'load' then a brief
// networkidle wait). The explicit wait_until='networkidle' uses a longer bound.
const NAV_IDLE_DEFAULT_MS     = 2_000
const NAV_IDLE_EXPLICIT_MS    = 10_000

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

// ─── Popup / cookie-banner cleanup (remove_popups) ────────────────────────────────
// Generic, click-free DOM pass that runs in the page. Removes cookie/consent/
// newsletter overlays and full-screen backdrops, and un-locks html/body scrolling so
// full-page captures work. Conservative: a small top header/nav (<15% viewport, at the
// very top) is NEVER removed unless it carries consent wording. Runs inside a try in
// the browser and returns a count; the caller also wraps it so a throw never fails a
// capture. Kept as a standalone function so it can be unit-driven via Playwright.
export const REMOVE_POPUPS_SCRIPT = (): number => {
  let removed = 0
  const vw = window.innerWidth, vh = window.innerHeight
  if (!document.body || vw < 1 || vh < 1) return 0
  // CONSENT/cookie wording (incl. common non-English terms) — a small top header/nav
  // is removed ONLY if it carries THIS. Annoyance wording (newsletter/subscribe) alone
  // must NOT strip a real nav bar that happens to have a "Subscribe" button.
  const consentRx = /cookie|consent|consentement|datenschutz|privacidad|privacy|gdpr|dsgvo|zustimmen|einwilligung|politique de confidentialit|we use cookies|accept all/i
  const annoyRx = /newsletter|subscribe|sign\s?up|akzeptieren|aceptar|accetta/i
  const text = (el: Element) => (el.textContent || '').slice(0, 3000)
  const num = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
  const areaFrac = (r: DOMRect) => (Math.max(0, r.width) * Math.max(0, r.height)) / (vw * vh)

  // Collect elements from the light DOM AND any OPEN shadow roots (recursively), so
  // consent overlays that live inside web components (e.g. reddit) are reachable.
  const collect = (root: ParentNode, out: HTMLElement[], depth: number): HTMLElement[] => {
    if (depth > 8) return out
    const els = root.querySelectorAll<HTMLElement>('*')
    for (let i = 0; i < els.length; i++) {
      const el = els[i]
      out.push(el)
      const sr = el.shadowRoot // open shadow roots only (closed roots are inaccessible)
      if (sr) collect(sr, out, depth + 1)
    }
    return out
  }
  const allEls = collect(document.body, [], 0)

  // Pass 1: fixed/sticky overlays and consent banners.
  for (const el of allEls) {
    if (!el.isConnected) continue
    const cs = getComputedStyle(el)
    const pos = cs.position
    if (pos !== 'fixed' && pos !== 'sticky') continue
    if (cs.display === 'none' || cs.visibility === 'hidden' || num(cs.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const area = areaFrac(r)
    const z = Math.round(num(cs.zIndex))
    const t = text(el)
    const isConsent = consentRx.test(t)
    const isAnnoy = annoyRx.test(t)
    const isTopAnchored = r.top <= 2
    // Protect anything pinned to the very TOP that is not a consent bar and does not
    // cover the page: real headers / nav / announcement bars — even tall ones with a
    // "Subscribe" button. (A top-anchored consent bar or full-page overlay is NOT
    // protected and is handled below.)
    if (isTopAnchored && !isConsent && area <= 0.30) continue
    const highZ = z >= 100
    // Full-page overlay / modal (consent, newsletter, or generic) → remove.
    if (highZ && area > 0.30) { el.remove(); removed++; continue }
    // Consent/cookie banner at any size or position (top or bottom bar) → remove.
    if (isConsent && area >= 0.03) { el.remove(); removed++; continue }
    // Newsletter/subscribe pop-in that is NOT a top nav bar (centered/slide-in) → remove.
    if (isAnnoy && highZ && area >= 0.15) { el.remove(); removed++; continue }
  }

  // Pass 2: full-screen backdrops/overlays (fixed, near-full-viewport, empty or semi-transparent).
  for (const el of allEls) {
    if (!el.isConnected) continue
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed') continue
    const r = el.getBoundingClientRect()
    if (areaFrac(r) < 0.85) continue
    const bg = cs.backgroundColor || ''
    const semiTransparent = /rgba?\([^)]*,\s*(0?\.\d+)\s*\)/.test(bg) || (num(cs.opacity) > 0 && num(cs.opacity) < 1)
    const empty = el.childElementCount === 0 || (el.textContent || '').trim().length === 0
    if (semiTransparent || empty) { el.remove(); removed++ }
  }

  // Pass 3: un-lock scroll (scroll-locking overlays set these on html/body).
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue
    const cs = getComputedStyle(el)
    if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') el.style.setProperty('overflow', 'auto', 'important')
    if (cs.position === 'fixed') el.style.setProperty('position', 'static', 'important')
  }
  return removed
}

// Bedrock structured extraction — extracted so it can start early and run in parallel
// with the screenshot. Returns aiData on success, aiError on failure (graceful), and
// the pure model-call duration. The raw provider error is logged server-side only.
async function runBedrockExtraction(
  aiExtract: Record<string, boolean>,
  pageText: string,
): Promise<{ aiData?: Record<string, unknown>; aiError?: string; ms: number }> {
  const t0 = Date.now()
  try {
    const fields = Object.keys(aiExtract).filter((k) => aiExtract[k])
    const prompt = `Extract structured data from this webpage. Return ONLY valid JSON with requested fields.\n- page_type: one of [pricing, docs, blog, landing, product, other]\n- prices: array of price strings\n- headings: array of main headings\n- ctas: array of CTA button texts\nNo explanation. Just JSON.\n\nPage content:\n${pageText.slice(0, 8000)}\n\nRequested fields: ${JSON.stringify(fields)}`
    const response = await bedrockClient!.send(
      new ConverseCommand({
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        messages: [{ role: 'user', content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 1024, temperature: 0 },
      }),
    )
    const result = response.output?.message?.content?.[0]?.text
    if (result) {
      try { return { aiData: JSON.parse(result.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()), ms: Date.now() - t0 } }
      catch { return { aiData: { raw: result }, ms: Date.now() - t0 } }
    }
    return { ms: Date.now() - t0 }
  } catch (err) {
    const aiError = err instanceof Error ? err.message : 'Unknown error'
    console.error('Bedrock error:', aiError)
    return { aiError, ms: Date.now() - t0 }
  }
}

// Does this capture carry per-viewer auth material for the TARGET page — anything
// that makes the page render differently for one caller than another (cookies, custom
// request headers, an Authorization meant for the target)? The capture cache key is
// deliberately caller-agnostic (url + render options only — see performCapture), so a
// viewer-specific render MUST NOT be cached: doing so would serve one customer's
// authenticated page to the next caller of the same URL. True → bypass cache read AND
// write, render fresh. Nothing populates these fields today, so this returns false for
// every current request and the cache behaves exactly as before.
export function carriesTargetAuthMaterial(opts: CaptureOpts): boolean {
  const { cookies, extraHeaders, targetAuthorization } = opts
  const hasCookies =
    typeof cookies === 'string' ? cookies.trim().length > 0
    : Array.isArray(cookies) ? cookies.length > 0
    : (cookies != null && typeof cookies === 'object') ? Object.keys(cookies as object).length > 0
    : false
  const hasHeaders = !!extraHeaders && Object.keys(extraHeaders).length > 0
  const hasAuth = typeof targetAuthorization === 'string' && targetAuthorization.trim().length > 0
  return hasCookies || hasHeaders || hasAuth
}

// Bounded write for an in-memory cache map (the Redis-absent fallback path only).
// Plain Maps have neither TTL nor eviction, so this keeps them from growing without
// limit: first sweep entries past CACHE_TTL_MS, then, if a NEW key would exceed the
// cap, evict oldest-first (Map preserves insertion order), then insert. The Redis
// path is untouched — setex already bounds it with a 60s TTL.
export function boundedCacheSet<V extends { timestamp: number }>(
  map: Map<string, V>, key: string, value: V, now: number, cap = MAX_MEMORY_CACHE_ENTRIES,
): void {
  for (const [k, v] of map) { if (now >= v.timestamp + CACHE_TTL_MS) map.delete(k) }
  if (!map.has(key)) {
    while (map.size >= cap) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }
  map.set(key, value)
}

async function performCapture(opts: CaptureOpts): Promise<CaptureResult> {
  const { url, format, fullPage, width, height, includeText, aiExtract, ownerId } = opts
  const waitUntil = opts.waitUntil
  const delayMs = Math.min(10_000, Math.max(0, Math.floor(opts.delayMs ?? 0)))
  const blockAds = opts.blockAds === true
  const removePopups = opts.removePopups === true
  const darkMode = opts.darkMode === true
  const deviceScaleFactor = Math.min(3, Math.max(1, opts.deviceScaleFactor ?? 1))
  const captureImage = opts.captureImage !== false // default true; false = REST data mode
  const skipAi = opts.skipAi === true // AI requested but quota exhausted → skip Bedrock, still capture
  // An ai_extract object where every value is false (or {}) is NOT an AI request:
  // don't extract text for it, don't invoke Bedrock, don't consume AI quota.
  const aiRequested = !!aiExtract && Object.values(aiExtract).some((v) => v === true)
  const dataMode = includeText || aiRequested // JSON (text/ai) result, not an image
  // Only REST data mode (no image) caches the JSON result. MCP sets captureImage=true
  // even with ai_extract because it must return the image, so it is never data-cached.
  const useDataCache = dataMode && !captureImage
  const startTime = Date.now()
  const timings: Record<string, number> = {}
  const mark = (k: string, from: number) => { timings[k] = Date.now() - from }

  // SSRF guard (incl. DNS resolution) — fail fast before touching the browser.
  // A resolve-failure here is a real "domain not found" (dns_failed/400), NOT a security
  // block; a private-IP / internal-host refusal stays a distinct blocked_url refusal.
  const tValidate = Date.now()
  const safe = await validateSafeUrl(url)
  mark('validationMs', tValidate)
  if (!safe.ok) {
    if (safe.kind === 'dns') return { ok: false, kind: 'capture', code: 'dns_failed', message: captureFailMessage('dns_failed', hostOf(url)) }
    return { ok: false, kind: 'ssrf', message: safe.reason }
  }

  // Cache keys — MUST include every render-affecting parameter so different options
  // never collide. Image cache stores the binary; data cache stores the JSON result.
  //
  // Caller identity (API key / user / org) is DELIBERATELY absent: identical public
  // pages requested by different customers are byte-identical, so a shared, caller-
  // agnostic key is what gives us a cross-customer hit rate. That is only safe while
  // the render depends solely on (url + render options). The moment a request carries
  // per-viewer auth material (cookies/headers/authorization for the target page), the
  // render becomes viewer-specific and this shared key would collide across customers —
  // serving one customer's authenticated page to another. carriesTargetAuthMaterial()
  // is the guard: when it is true we bypass the cache entirely (read AND write below),
  // so such a render is never stored under, nor served from, a caller-agnostic key.
  const bypassCache = carriesTargetAuthMaterial(opts)
  const renderKey = `${format}:${fullPage}:${width}x${height}:wu=${waitUntil ?? 'def'}:d=${delayMs}:ad${blockAds ? 1 : 0}:pp${removePopups ? 1 : 0}:dk${darkMode ? 1 : 0}:dsf${deviceScaleFactor}`
  const cacheKey = `cache:${CAPTURE_CACHE_VERSION}:${url}:${renderKey}`
  const aiFieldsKey = aiExtract ? Object.keys(aiExtract).filter((k) => aiExtract[k]).sort().join(',') : ''
  const dataCacheKey = `datacache:${CAPTURE_CACHE_VERSION}:${url}:${renderKey}:it${includeText ? 1 : 0}:ai=${aiFieldsKey}`
  const now = Date.now()

  if (useDataCache && !bypassCache) {
    // ── Data-mode cache (text / ai_data JSON), served + logged like an image hit ──
    if (redis) {
      try {
        const hit = await redis.get(dataCacheKey)
        if (hit) {
          const d = JSON.parse(hit) as { pageText: string | null; aiData?: Record<string, unknown>; aiError?: string }
          logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: 0, cached: true })
          return { ok: true, buffer: Buffer.alloc(0), contentType: getContentType(format), format, width, height, renderTime: 0, cached: true, pageText: d.pageText ?? null, aiData: d.aiData, aiError: d.aiError, timings }
        }
      } catch (err) { console.error('Redis data-cache get error:', err) }
    } else {
      const cd = dataCacheMap.get(dataCacheKey)
      if (cd && now < cd.timestamp + CACHE_TTL_MS) {
        logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: 0, sizeKb: 0, cached: true })
        return { ok: true, buffer: Buffer.alloc(0), contentType: getContentType(format), format, width, height, renderTime: 0, cached: true, pageText: cd.pageText, aiData: cd.aiData, aiError: cd.aiError, timings }
      }
    }
  } else if (!includeText && !aiExtract && !bypassCache) {
    // ── Image cache (plain capture only) ──
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
    context = await b.newContext({ colorScheme: darkMode ? 'dark' : 'light', deviceScaleFactor })
    const page = await context.newPage()
    await page.setViewportSize({ width, height })
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })
    // Enable request-blocking engines for this page only when asked. Independent of
    // each other; both can be on. A missing/failed engine → capture without blocking.
    if (blockAds && adBlocker) {
      try { await adBlocker.enableBlockingInPage(page) } catch (err) { console.error('block_ads enable failed (continuing):', err instanceof Error ? err.message : 'unknown') }
    }
    if (removePopups && popupBlocker) {
      try { await popupBlocker.enableBlockingInPage(page) } catch (err) { console.error('remove_popups blocker enable failed (continuing):', err instanceof Error ? err.message : 'unknown') }
    }
    mark('contextCreateMs', tCtx)

    // ── Navigation + wait strategy ─────────────────────────────────────────────
    // 30s goto cap always. waitForLoadState timeouts are SWALLOWED — a page that
    // never goes network-quiet must still be captured with whatever has rendered.
    const tNav = Date.now()
    const gotoWait: WaitUntil = (waitUntil === 'load' || waitUntil === 'domcontentloaded' || waitUntil === 'commit') ? waitUntil : 'load'
    // Wrap goto specifically so a NAVIGATION failure (DNS/refused/timeout/TLS) maps to a
    // precise code, distinct from a post-navigation render error (→ render_failed below).
    let pageStatus: number | null = null
    try {
      const resp = await page.goto(url, { waitUntil: gotoWait, timeout: NAV_TIMEOUT_MS })
      pageStatus = resp?.status() ?? null
    } catch (err) {
      const code = classifyCaptureError(err)
      console.error(`Capture nav error [${code}] for ${hostOf(url)}:`, err instanceof Error ? err.message : 'unknown')
      logScreenshot({ userId: ownerId, url, format, status: CAPTURE_FAIL_STATUS[code], timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
      return { ok: false, kind: 'capture', code, message: captureFailMessage(code, hostOf(url)) }
    }
    mark('navigationMs', tNav)
    const tSettle = Date.now()
    if (waitUntil === undefined) {
      // Default: goto 'load', then a short networkidle wait (best-effort).
      try { await page.waitForLoadState('networkidle', { timeout: NAV_IDLE_DEFAULT_MS }) } catch { fallbackUsed = true }
    } else if (waitUntil === 'networkidle') {
      // Explicit networkidle: goto 'load', then a longer networkidle wait (best-effort).
      try { await page.waitForLoadState('networkidle', { timeout: NAV_IDLE_EXPLICIT_MS }) } catch { fallbackUsed = true }
    }
    // load / domcontentloaded / commit: nothing extra after goto.
    if (delayMs > 0) await page.waitForTimeout(delayMs)
    mark('settleMs', tSettle)

    // ── Meaningful-content guard: only discard if the page produced ~nothing. ──
    // Exception: if the TARGET returned an HTTP error (4xx/5xx), an empty-ish error page
    // is still a valid capture — serve it (with X-Shotbase-Page-Status) rather than
    // discarding it as a render failure.
    const httpErrorPage = pageStatus != null && pageStatus >= 400
    const hasContent = await page.evaluate(
      () => ((document.body?.innerText || '').trim().length > 0) || ((document.body?.childElementCount ?? 0) > 3)
    ).catch(() => true)
    if (!hasContent && !httpErrorPage) {
      logScreenshot({ userId: ownerId, url, format, status: 500, timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
      return { ok: false, kind: 'capture', code: 'render_failed', message: captureFailMessage('render_failed', hostOf(url)) }
    }

    // ── Popup / cookie-banner DOM cleanup (remove_popups) ──────────────────────
    // Runs after wait+delay and before the prepass so full-page scrolling works on
    // the un-locked page. A throw is logged and ignored — capture proceeds anyway.
    if (removePopups) {
      const tPopups = Date.now()
      try {
        const removed = await page.evaluate(REMOVE_POPUPS_SCRIPT)
        if (removed > 0) console.log(`[remove_popups] removed ${removed} element(s)`)
      } catch (err) {
        console.error('remove_popups cleanup error (continuing):', err instanceof Error ? err.message : 'unknown')
      }
      mark('popupsMs', tPopups)
    }

    // ── Fixed/sticky top-element overlay: DETECT + SNAPSHOT (page still at top) ──
    // Runs BEFORE the prepass while scrollY≈0, so the navbar is captured exactly as
    // a first-time visitor sees it. Only full-page image captures; failures are
    // non-fatal (skip the overlay, fall back to the plain full-page shot).
    let fixedOverlay: Buffer | null = null
    let fixedOverlayDetected = false
    let fixedOverlayHeight = 0
    let fixedOverlayMs = 0
    const wantFixedOverlay = captureImage && fullPage && format !== 'pdf' && FULLPAGE_SCROLL_ENABLED && FULLPAGE_FIXED_OVERLAY_ENABLED
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
    if (dataMode) {
      try {
        pageText = await page.evaluate(() => document.body.innerText)
        pageText = pageText?.replace(/\n\s*\n/g, '\n\n').trim() ?? null
      } catch (err) {
        pageText = `extraction failed: ${err instanceof Error ? err.message : 'unknown'}`
      }
    }
    mark('pageTextMs', tText)

    // Start Bedrock the moment text is available so it overlaps the screenshot; await
    // it after. In data mode there is no screenshot to overlap (Bedrock runs alone).
    const doBedrock = aiRequested && !skipAi && !!aiExtract && !!bedrockClient && !!pageText
    const bedrockPromise = doBedrock
      ? runBedrockExtraction(aiExtract as Record<string, boolean>, pageText as string)
      : Promise.resolve<{ aiData?: Record<string, unknown>; aiError?: string; ms: number }>({ ms: 0 })

    // ── Screenshot — SKIPPED in REST data mode (screenshot_url is null there). ──
    const tShot = Date.now()
    let buffer: Buffer = Buffer.alloc(0)
    let contentType = getContentType(format)
    let fixedOverlayComposited = false
    if (captureImage) {
      if (format === 'pdf') {
        buffer = Buffer.from(await page.pdf({ format: 'A4', printBackground: true }))
        contentType = 'application/pdf'
      } else if (fixedOverlay) {
        // Full-page image with a captured top overlay: hide the detected fixed/sticky
        // elements for the shot (no stray/duplicate copy at the bottom), take the
        // full-page PNG, restore, then composite the overlay strip back at y=0. Both
        // images are the same width at the same DPR, so the composite aligns exactly.
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

    // Await the (parallel) Bedrock result. A failure is reported via aiError only.
    const bedrock = await bedrockPromise
    const aiData = bedrock.aiData
    const aiError = bedrock.aiError
    timings.bedrockMs = bedrock.ms
    // ai_succeeded is true ONLY when Bedrock produced an AI result. A Bedrock
    // failure (graceful degradation → aiData undefined + aiError) stays false.
    const aiSucceeded = aiRequested && aiData !== undefined
    const renderTime = Date.now() - startTime
    timings.totalMs = renderTime

    // ── Cache write (fire-and-forget for Redis so it never blocks the response) ──
    const tCacheWrite = Date.now()
    // bypassCache → viewer-specific render: never persist it under a caller-agnostic key.
    if (useDataCache && !bypassCache) {
      const payload = { pageText, aiData, aiError }
      if (redis) redis.setex(dataCacheKey, 60, JSON.stringify(payload)).catch((err) => console.error('Redis data-cache write error:', err instanceof Error ? err.message : 'unknown'))
      else boundedCacheSet(dataCacheMap, dataCacheKey, { ...payload, timestamp: now }, now)
    } else if (!includeText && !aiExtract && !bypassCache) {
      if (redis) redis.setex(cacheKey, 60, buffer.toString('base64')).catch((err) => console.error('Redis cache write error:', err instanceof Error ? err.message : 'unknown'))
      else boundedCacheSet(cacheMap, cacheKey, { buffer, format, timestamp: now }, now)
    }
    mark('cacheWriteMs', tCacheWrite)
    // NOTE: a rendered 4xx/5xx page reaches here and is logged status:200 — it IS a
    // served capture and therefore COUNTS against capture quota (see X-Shotbase-Page-Status).
    logScreenshot({ userId: ownerId, url, format, status: 200, timeMs: renderTime, sizeKb: buffer.length / 1024, cached: false, aiRequested, aiSucceeded })

    return { ok: true, buffer, contentType, format, width, height, renderTime, cached: false, pageText, aiData, aiError, timings, fallbackUsed, pageStatus, scrollDiag,
      fixedOverlay: wantFixedOverlay ? { detected: fixedOverlayDetected, height: fixedOverlayHeight, composited: fixedOverlayComposited, ms: fixedOverlayMs } : undefined }
  } catch (err) {
    // Post-navigation failure (screenshot/evaluate/etc.) — navigation errors are already
    // classified above. Raw error stays server-side; caller gets a generic render_failed.
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('Screenshot error:', msg)
    logScreenshot({ userId: ownerId, url, format, status: 500, timeMs: Date.now() - startTime, sizeKb: 0, cached: false, aiRequested })
    return { ok: false, kind: 'capture', code: 'render_failed', message: captureFailMessage('render_failed', hostOf(url)) }
  } finally {
    if (context) await context.close().catch(() => {})
    permit.release() // ALWAYS — success, capture error, or browser crash/relaunch
  }
}

// Client-facing message for any AI-extraction failure. The full provider error
// (which can carry AWS account state, IAM/ARN details, or other internals) is
// logged server-side only — never returned to the caller.
const AI_EXTRACT_UNAVAILABLE_MSG = 'AI extraction temporarily unavailable'

// ─── Server-Timing instrumentation ───────────────────────────────────────────
// Emit a standard `Server-Timing` header (and a matching log line) so per-stage
// latency is visible in the browser/network tab and logs. Handler stages
// (verify_key, rate_limit, quota) are measured in the route; capture stages come
// from performCapture's internal `timings` (mapped to stable public stage names).
const CAPTURE_STAGE_NAMES: Record<string, string> = {
  validationMs:    'dns_check',
  contextCreateMs: 'new_context',
  navigationMs:    'goto',
  settleMs:        'settle',
  popupsMs:        'popups',
  pageTextMs:      'page_text',
  screenshotMs:    'screenshot',
  bedrockMs:       'bedrock',
  cacheWriteMs:    'cache_write',
}
const SERVER_TIMING_ORDER = [
  'verify_key', 'rate_limit', 'quota', 'dns_check', 'new_context', 'goto',
  'settle', 'popups', 'page_text', 'screenshot', 'bedrock', 'cache_write',
]
function captureStageTimings(timings?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  if (!timings) return out
  for (const [internal, name] of Object.entries(CAPTURE_STAGE_NAMES)) {
    if (typeof timings[internal] === 'number') out[name] = timings[internal]
  }
  return out
}
function buildServerTiming(stages: Record<string, number>): string {
  return SERVER_TIMING_ORDER
    .filter((k) => typeof stages[k] === 'number')
    .map((k) => `${k};dur=${Math.round(stages[k])}`)
    .join(', ')
}

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

// Usage numbers read during the quota check, reused to build the response quota
// headers (no extra Supabase round trips). aiUsage/aiLimit are null when the request
// did not ask for AI (that count is only read when aiRequested).
interface QuotaUsage { captureUsage: number; captureLimit: number; aiUsage: number | null; aiLimit: number | null }
type QuotaResult =
  | { ok: true; plan: CanonicalPlan; aiExhausted: boolean; usage: QuotaUsage }
  | { ok: false; kind: 'quota'; quotaType: 'captures'; plan: CanonicalPlan; limit: number; used: number }
  | { ok: false; kind: 'accounting' }
// Resolve the effective, normalized plan AND enforce the monthly caps in one place,
// returning the plan for rate limiting. For a playground (bypass) caller the REAL
// plan lives in Supabase users.plan (the bypass authenticates as a generic 'pro'
// placeholder — a Free user must NOT inherit it); that lookup runs IN PARALLEL with
// the capture-usage count, so a bypass request is one round-trip instead of two.
// The X-Shotbase-User-Id header is never trusted for plan.
//
// CAPTURE quota is a hard gate (over → ok:false, the caller 429s). AI quota is NOT:
// when the capture quota is fine but AI is exhausted we return ok:true with
// aiExhausted=true and let the caller decide whether to degrade (serve the
// capture/text, skip AI) or 429 — so a full AI budget never blocks a plain capture.
// Any required query failing → accounting failure (fail closed). Supabase unset →
// quota disabled, plan from the (normalized) key. NOTE: non-atomic (count → serve →
// fire-and-forget log), so concurrent requests at the boundary can overshoot.
async function checkMonthlyQuota(keyResult: UnkeyResult, ownerId: string, aiRequested: boolean): Promise<QuotaResult> {
  if (!supabase) {
    // Quota disabled (dev/self-host): no counts to read. Report limits with usage 0
    // so the headers show a full budget rather than nothing.
    const plan = normalizePlan(keyResult.plan)
    return { ok: true, plan, aiExhausted: false, usage: { captureUsage: 0, captureLimit: getCaptureQuota(plan), aiUsage: aiRequested ? 0 : null, aiLimit: aiRequested ? getAiExtractionQuota(plan) : null } }
  }

  const [planRaw, captureUsage] = await Promise.all([
    keyResult.viaBypass ? getUserPlan(ownerId) : Promise.resolve<string | null>(keyResult.plan),
    getMonthlyUsage(ownerId),
  ])
  if (keyResult.viaBypass && planRaw === null) return { ok: false, kind: 'accounting' } // real plan unresolved → fail closed
  const plan = normalizePlan(planRaw ?? keyResult.plan)
  if (captureUsage === null) return { ok: false, kind: 'accounting' } // count failed → fail closed
  const captureLimit = getCaptureQuota(plan)
  if (captureUsage >= captureLimit) {
    return { ok: false, kind: 'quota', quotaType: 'captures', plan, limit: captureLimit, used: captureUsage }
  }

  let aiUsage: number | null = null
  let aiLimit: number | null = null
  let aiExhausted = false
  if (aiRequested) {
    aiUsage = await getMonthlyAiUsage(ownerId)
    if (aiUsage === null) return { ok: false, kind: 'accounting' }
    aiLimit = getAiExtractionQuota(plan)
    aiExhausted = aiUsage >= aiLimit
  }
  return { ok: true, plan, aiExhausted, usage: { captureUsage, captureLimit, aiUsage, aiLimit } }
}

// Next monthly reset as a unix epoch (start of next UTC month), for X-Shotbase-Quota-Reset.
function monthlyResetEpoch(): number {
  const n = new Date()
  return Math.floor(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, 1) / 1000)
}
// Quota headers for a successful response, from the counts checkMonthlyQuota already
// read — NO extra Supabase round trips. AI-Remaining is only emitted when AI usage
// was actually read (i.e. the request asked for AI); a plain capture never reads it.
function quotaHeaders(u: QuotaUsage): Record<string, string> {
  const h: Record<string, string> = {
    'X-Shotbase-Captures-Remaining': String(Math.max(0, u.captureLimit - u.captureUsage)),
    'X-Shotbase-Quota-Reset': String(monthlyResetEpoch()),
  }
  if (u.aiLimit !== null && u.aiUsage !== null) h['X-Shotbase-AI-Remaining'] = String(Math.max(0, u.aiLimit - u.aiUsage))
  return h
}

// Read-only quota snapshot for GET /quota: resolves the real plan and reads BOTH
// monthly counts (captures + AI) WITHOUT enforcing anything or spending a capture.
// Unlike checkMonthlyQuota it never 429s and always reads the AI count. Fail closed:
// a plan or count query failure → accounting error (503), never a fabricated number.
// Supabase unset (dev/self-host) → quota disabled, usage 0 against the key's plan.
type QuotaSnapshot =
  | { ok: true; plan: CanonicalPlan; captureUsage: number; captureLimit: number; aiUsage: number; aiLimit: number }
  | { ok: false; kind: 'accounting' }
async function getQuotaSnapshot(keyResult: UnkeyResult, ownerId: string): Promise<QuotaSnapshot> {
  if (!supabase) {
    const plan = normalizePlan(keyResult.plan) // quota disabled → report a full budget
    return { ok: true, plan, captureUsage: 0, captureLimit: getCaptureQuota(plan), aiUsage: 0, aiLimit: getAiExtractionQuota(plan) }
  }
  const [planRaw, captureUsage, aiUsage] = await Promise.all([
    keyResult.viaBypass ? getUserPlan(ownerId) : Promise.resolve<string | null>(keyResult.plan),
    getMonthlyUsage(ownerId),
    getMonthlyAiUsage(ownerId),
  ])
  if (keyResult.viaBypass && planRaw === null) return { ok: false, kind: 'accounting' } // real plan unresolved → fail closed
  if (captureUsage === null || aiUsage === null) return { ok: false, kind: 'accounting' } // count failed → fail closed
  const plan = normalizePlan(planRaw ?? keyResult.plan)
  return { ok: true, plan, captureUsage, captureLimit: getCaptureQuota(plan), aiUsage, aiLimit: getAiExtractionQuota(plan) }
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// ─── Health check (honest, cached) ────────────────────────────────────────────
// Public response is only { status, service }; per-subsystem detail is logged, not
// exposed. Supabase (skipped if unconfigured) and the browser gate the status;
// Redis is best-effort (we fall back to memory). Bedrock is NEVER probed (it costs
// money per call). Result is cached HEALTH_CACHE_MS so healthcheck polling is cheap.
const HEALTH_CACHE_MS = 10_000
let healthCache: { at: number; ok: boolean } | null = null
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}
async function computeHealth(): Promise<boolean> {
  let ok = true
  // Supabase — cheap connectivity query, 2s cap. Skipped when not configured (dev).
  if (supabase) {
    try {
      const { error } = await withTimeout(
        (async () => supabase!.from('screenshots').select('id', { head: true }).limit(1))(),
        2_000, 'supabase',
      )
      if (error) throw new Error(error.message)
    } catch (err) {
      console.error('[health] supabase check failed → degraded:', err instanceof Error ? err.message : 'unknown')
      ok = false
    }
  }
  // Browser — if disconnected, try to (re)launch within a 10s cap. Failure → degraded.
  if (!(browser?.isConnected() ?? false)) {
    try {
      await withTimeout(getBrowser(), 10_000, 'browser')
    } catch (err) {
      console.error('[health] browser launch failed → degraded:', err instanceof Error ? err.message : 'unknown')
      ok = false
    }
  }
  // Redis — 1s ping; a failure is logged but does NOT degrade (memory fallback).
  if (redis) {
    try { await withTimeout(redis.ping(), 1_000, 'redis') }
    catch (err) { console.error('[health] redis ping failed (non-fatal, memory fallback):', err instanceof Error ? err.message : 'unknown') }
  }
  return ok
}
app.get('/health', async (c) => {
  const now = Date.now()
  if (!healthCache || now - healthCache.at >= HEALTH_CACHE_MS) {
    healthCache = { at: now, ok: await computeHealth() }
  }
  const ok = healthCache.ok
  return c.json({ status: ok ? 'ok' : 'degraded', service: 'shotbase' }, ok ? 200 : 503)
})

// ─── TEST-ONLY: browser-gate occupier ────────────────────────────────────────────
// Registered ONLY when SHOTBASE_TEST_GATE_OCCUPY=1 (see the boot guard above); with the
// var unset this route does not exist. It acquires a real browser-gate permit and holds
// it for a bounded time — no capture, no navigation, no SSRF — so a load test can fill
// the gate deterministically and assert that /screenshot and MCP then return 503. Same
// API-key auth as every other endpoint (never anonymous); duration hard-capped at 5s
// server-side; every use logged loudly at warn with the caller.
if (GATE_OCCUPY_ENABLED) {
  const GATE_OCCUPY_MAX_MS = 5000
  app.post('/__gate/occupy', async (c) => {
    const authorization = c.req.header('Authorization')
    if (!authorization) return c.json({ error: 'Missing Authorization header' }, 401)
    const m = authorization.match(/^Bearer\s+(.+)$/)
    const apiKey = m?.[1]?.trim()
    if (!apiKey) return c.json({ error: 'Invalid authorization format. Use: Bearer <key>' }, 401)
    const keyResult = await verifyKey(apiKey)
    if (!keyResult.valid) return c.json({ error: keyResult.error ?? 'Invalid API key' }, 401)
    const owner = resolveOwner(keyResult, c.req.header(INTERNAL_USER_HEADER))
    if (!owner.ok) return c.json({ error: owner.message }, 401)

    let body: Record<string, unknown> | null = null
    try { body = await c.req.json() } catch { /* stays null */ }
    const reqMs = Number(body?.ms ?? 0)
    const ms = Math.min(GATE_OCCUPY_MAX_MS, Math.max(0, Number.isFinite(reqMs) ? Math.floor(reqMs) : 0))
    console.warn(`[gate-occupy] TEST-ONLY gate occupier used by owner=${owner.ownerId} requested_ms=${body?.ms ?? 0} capped_ms=${ms}`)

    let permit: Permit
    try {
      permit = await browserGate.acquire()
    } catch (err) {
      // Gate already full → same overload contract as a capture.
      return c.json(
        { error: 'Server busy', detail: err instanceof Error ? err.message : 'overloaded' },
        503,
        { 'Retry-After': String(Math.ceil((BROWSER_QUEUE_TIMEOUT_MS || 1000) / 1000)) },
      )
    }
    try { await new Promise((r) => setTimeout(r, ms)) } finally { permit.release() }
    return c.json({ occupied_ms: ms }, 200)
  })
}

// ─── Quota (read remaining budget without spending a capture) ────────────────────
// Authenticated, rate-limited, read-only. Returns captures + AI extractions used/
// limit/remaining and the next reset epoch — so a caller can check its budget
// without making an ai_extract call just to read a header. NEVER counts a capture.
// A read-only budget check is cheap, so /quota gets its own looser per-minute
// ceiling on a SEPARATE bucket (see the handler) — polling it never competes with
// the caller's capture/MCP rate limit. Fixed across plans; generous but not unlimited.
const QUOTA_RPM = 60
app.get('/quota', async (c) => {
  const authorization = c.req.header('Authorization')
  if (!authorization) return c.json({ error: 'Missing Authorization header' }, 401)
  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) return c.json({ error: 'Invalid authorization format. Use: Bearer <key>' }, 401)

  const keyResult = await verifyKey(apiKey)
  if (!keyResult.valid) return c.json({ error: keyResult.error ?? 'Invalid API key' }, 401)

  const owner = resolveOwner(keyResult, c.req.header(INTERNAL_USER_HEADER))
  if (!owner.ok) return c.json({ error: owner.message }, 401)
  const ownerId = owner.ownerId

  // Rate limit BEFORE any Supabase query. /quota has its OWN bucket (the `quota:`
  // prefix keeps it off the capture bucket) with a looser fixed ceiling, so polling
  // your budget never burns the per-minute capture/MCP budget you're polling about.
  const rlPlan = normalizePlan(keyResult.plan)
  const rlBucket = keyResult.viaBypass ? `quota:user:${ownerId}` : `quota:key:${apiKey}`
  if (await checkRateLimit(rlBucket, rlPlan, QUOTA_RPM)) {
    return c.json({ error: `Rate limit exceeded. /quota allows ${QUOTA_RPM} requests/minute.` }, 429)
  }

  const snap = await getQuotaSnapshot(keyResult, ownerId)
  if (!snap.ok) return c.json({ error: 'Usage temporarily unavailable' }, 503) // accounting dependency failed → fail closed

  const reset = monthlyResetEpoch()
  const capRemaining = Math.max(0, snap.captureLimit - snap.captureUsage)
  const aiRemaining = Math.max(0, snap.aiLimit - snap.aiUsage)
  return c.json(
    {
      plan: snap.plan,
      captures: { used: snap.captureUsage, limit: snap.captureLimit, remaining: capRemaining },
      ai_extractions: { used: snap.aiUsage, limit: snap.aiLimit, remaining: aiRemaining },
      reset,
    },
    200,
    {
      'X-Shotbase-Captures-Remaining': String(capRemaining),
      'X-Shotbase-AI-Remaining': String(aiRemaining),
      'X-Shotbase-Quota-Reset': String(reset),
    },
  )
})

app.post('/screenshot', screenshotBodyLimit, async (c) => {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const authorization = c.req.header('Authorization')
  if (!authorization) return c.json({ error: 'Missing Authorization header' }, 401)

  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) return c.json({ error: 'Invalid authorization format. Use: Bearer <key>' }, 401)

  const stage: Record<string, number> = {}
  const tVerify = Date.now()
  const keyResult = await verifyKey(apiKey)
  stage.verify_key = Date.now() - tVerify
  if (!keyResult.valid) return c.json({ error: keyResult.error ?? 'Invalid API key' }, 401)

  // Attribute to the real user. Bypass callers MUST assert a valid user id or we
  // fail closed (never log as generic "playground"). Non-bypass keys ignore the header.
  const owner = resolveOwner(keyResult, c.req.header(INTERNAL_USER_HEADER))
  if (!owner.ok) return c.json({ error: owner.message }, 401)
  const ownerId = owner.ownerId

  // ── Rate limit — BEFORE any Supabase query, so a flood never hits the database ──
  // Bucket: the resolved user id for playground (bypass) callers (one user can't
  // exhaust the shared bypass bucket), else the API key. RPM uses the key's own plan
  // (Unkey meta for API keys; the bypass placeholder for playground) — the real
  // plan needs a Supabase lookup, which is deferred to the monthly-quota check.
  const rlPlan = normalizePlan(keyResult.plan)
  const rlBucket = keyResult.viaBypass ? `user:${ownerId}` : `key:${apiKey}`
  const tRate = Date.now()
  const rateLimited = await checkRateLimit(rlBucket, rlPlan)
  stage.rate_limit = Date.now() - tRate
  if (rateLimited) {
    return c.json({ error: `Rate limit exceeded. ${rlPlan} plan allows ${getRateLimitPerMinute(rlPlan)} requests/minute.` }, 429)
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
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

  // ── Wait strategy + render options (all optional, validated like the rest) ──
  let waitUntil: WaitUntil | undefined
  if (body?.wait_until !== undefined) {
    if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(body.wait_until as string)) {
      return c.json({ error: '"wait_until" must be one of: load, domcontentloaded, networkidle, commit' }, 400)
    }
    waitUntil = body.wait_until as WaitUntil
  }
  const delayMs = (body?.delay_ms ?? 0) as number
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 10000) {
    return c.json({ error: '"delay_ms" must be an integer between 0 and 10000' }, 400)
  }
  const blockAds = body?.block_ads ?? false
  if (typeof blockAds !== 'boolean') return c.json({ error: '"block_ads" must be a boolean' }, 400)
  const removePopups = body?.remove_popups ?? false
  if (typeof removePopups !== 'boolean') return c.json({ error: '"remove_popups" must be a boolean' }, 400)
  const darkMode = body?.dark_mode ?? false
  if (typeof darkMode !== 'boolean') return c.json({ error: '"dark_mode" must be a boolean' }, 400)
  const deviceScaleFactor = (body?.device_scale_factor ?? 1) as number
  if (typeof deviceScaleFactor !== 'number' || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 3) {
    return c.json({ error: '"device_scale_factor" must be a number between 1 and 3' }, 400)
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

  // ── Effective plan + monthly quota (Supabase; runs AFTER rate limiting) ───────
  const tQuota = Date.now()
  const quota = await checkMonthlyQuota(keyResult, ownerId, aiRequested)
  stage.quota = Date.now() - tQuota
  if (!quota.ok) {
    if (quota.kind === 'accounting') {
      return c.json({ error: 'Usage temporarily unavailable' }, 503) // accounting dependency failed → fail closed
    }
    // Capture quota exhausted → hard 429 (unchanged body; frontend branches on quota_type).
    return c.json(
      { error: 'Monthly capture quota exceeded', quota_type: quota.quotaType, limit: quota.limit, used: quota.used },
      429,
    )
  }

  // Quota headers for every successful response (built from counts already read).
  const qHeaders = quotaHeaders(quota.usage)

  // ── AI-quota exhausted, capture quota OK → degrade gracefully by request shape ──
  // Only ai_extract, nothing else to serve (no image in data mode, no text): keep the
  // hard 429 verbatim. Otherwise skip AI and serve the rest (with an ai_skipped marker).
  let aiSkipped = false
  if (aiRequested && quota.aiExhausted) {
    if (!includeText) {
      return c.json(
        { error: 'Monthly AI extraction quota exceeded', quota_type: 'ai_extractions', limit: quota.usage.aiLimit, used: quota.usage.aiUsage },
        429,
      )
    }
    aiSkipped = true // include_text present → serve the text, skip the (exhausted) AI call
  }

  // ── Capture (shared core) ──────────────────────────────────────────────────
  // REST data mode (include_text/ai_extract) returns JSON → skip the screenshot.
  const captureImage = !(includeText || aiRequested)
  const r = await performCapture({
    url, format, fullPage, width, height, includeText, aiExtract, ownerId,
    waitUntil, delayMs, blockAds, removePopups, darkMode, deviceScaleFactor, captureImage,
    skipAi: aiSkipped,
  })
  if (!r.ok) {
    // Every error body carries a stable `code` the frontend branches on (never the text).
    // A security refusal stays distinct from a resolve-failure: blocked_url vs dns_failed.
    if (r.kind === 'ssrf') return c.json({ error: 'Blocked URL', detail: r.message, code: 'blocked_url' }, 400)
    if (r.kind === 'overloaded') {
      return c.json(
        { error: 'Server busy', detail: r.message, code: 'server_busy' },
        503,
        { 'Retry-After': String(Math.ceil((r.retryAfterMs ?? 1000) / 1000)) },
      )
    }
    // Render/navigation failure: helpful message (incl. the caller's own hostname) + code.
    // The raw Playwright error is logged server-side only, never returned.
    return c.json({ error: r.message, code: r.code }, CAPTURE_FAIL_STATUS[r.code])
  }

  // ── Server-Timing (success responses only) ──────────────────────────────────
  const serverTiming = buildServerTiming({ ...stage, ...captureStageTimings(r.timings) })
  console.log(`[timing] ${url} cache=${r.cached ? 'HIT' : 'MISS'} ${serverTiming}`)

  // The target returned an HTTP error but rendered a page → this is still a valid 200
  // capture; surface the target's status so the caller can distinguish "your site 404'd"
  // from "our API failed". (A fresh capture only; cache hits don't carry it.)
  const pageStatusHeaders: Record<string, string> =
    (r.pageStatus != null && r.pageStatus >= 400) ? { 'X-Shotbase-Page-Status': String(r.pageStatus) } : {}

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
      // AI skipped because the monthly AI budget is spent (capture still served + counted).
      ai_data: aiRequested ? (aiSkipped ? null : (r.aiData ?? null)) : undefined,
      ai_skipped: (aiRequested && aiSkipped) ? 'monthly_quota_exceeded' : undefined,
      ai_error: (aiRequested && !aiSkipped && r.aiError) ? AI_EXTRACT_UNAVAILABLE_MSG : undefined,
      fallback_used: r.fallbackUsed ?? false,
      page_status: (r.pageStatus != null && r.pageStatus >= 400) ? r.pageStatus : undefined,
      timings: r.timings,
    }, 200, { 'Server-Timing': serverTiming, ...qHeaders, ...pageStatusHeaders })
  }

  if (r.cached) {
    return c.body(new Uint8Array(r.buffer), 200, { 'Content-Type': r.contentType, 'X-Cache': 'HIT', 'Server-Timing': serverTiming, ...qHeaders })
  }
  const imgHeaders: Record<string, string> = {
    'Content-Type': r.contentType,
    'X-Cache': 'MISS',
    'X-Render-Time': String(r.renderTime),
    'X-Nav-Fallback': String(r.fallbackUsed ?? false),
    'Server-Timing': serverTiming,
    ...qHeaders,
    ...pageStatusHeaders,
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

      // Rate limit — BEFORE any Supabase query. Bucket on the resolved user id for
      // bypass (else the API key); RPM from the key's own plan (real plan is looked
      // up later in the monthly-quota check).
      const rlPlan = normalizePlan(keyResult.plan)
      const rlBucket = keyResult.viaBypass ? `user:${owner.ownerId}` : `key:${apiKey}`
      if (await checkRateLimit(rlBucket, rlPlan)) {
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text: `Rate limit exceeded. ${rlPlan} plan allows ${getRateLimitPerMinute(rlPlan)} requests/minute.` }],
          isError: true,
        }))
      }

      // extract=true (default) needs BOTH capture + AI quota; extract=false only capture.
      const extract  = args.extract !== false // default true

      // Effective plan + monthly quota (Supabase; AFTER rate limiting). Returns the
      // real plan for playground bypass — never the 'pro' placeholder. AI-quota
      // exhaustion is NOT a hard fail here: MCP returns an image, so we serve it and
      // just skip the (exhausted) extraction — the "image + ai_extract" case.
      const quota = await checkMonthlyQuota(keyResult, owner.ownerId, extract)
      if (!quota.ok) {
        const text = quota.kind === 'accounting'
          ? 'Usage temporarily unavailable'
          : `Monthly capture quota exceeded. ${quota.plan} plan allows ${quota.limit} captures/month (used ${quota.used}).`
        return c.json(rpcResult(id, { content: [{ type: 'text', text }], isError: true }))
      }
      const mcpAiSkipped = extract && quota.aiExhausted // capture OK, AI budget spent → skip AI, still serve image

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
        captureImage: true, // MCP always returns the image
        skipAi: mcpAiSkipped,
      })

      if (!r.ok) {
        // Same stable codes as REST (exposed via header for branching); generic, useful
        // message in the content. Raw Playwright error stays server-side.
        const code = r.kind === 'ssrf' ? 'blocked_url' : r.kind === 'overloaded' ? 'server_busy' : r.code
        const text = r.kind === 'ssrf' ? `Blocked URL: ${r.message}`
          : r.kind === 'overloaded' ? `Server busy: ${r.message}`
          : r.message
        return c.json(rpcResult(id, {
          content: [{ type: 'text', text: `${text} (code: ${code})` }],
          isError: true,
        }), 200, { 'X-Shotbase-Error-Code': code })
      }

      const content: Array<Record<string, unknown>> = [
        { type: 'image', data: r.buffer.toString('base64'), mimeType: r.contentType },
      ]
      const out: Record<string, unknown> = { content, isError: false }
      if (extract) {
        if (mcpAiSkipped) {
          // AI budget spent this month — image served + counted, extraction skipped.
          content.push({ type: 'text', text: 'ai_skipped: monthly_quota_exceeded' })
        } else if (r.aiData) {
          content.push({ type: 'text', text: JSON.stringify(r.aiData) })
          out.structuredContent = r.aiData
        } else {
          // DEFERRED path: capture succeeded, intelligence unavailable (e.g. Bedrock gated).
          // Goes green automatically once the model returns JSON — no code change needed.
          // Generic marker only — the raw provider error (r.aiError) is logged server-side, never returned.
          content.push({ type: 'text', text: `extraction_unavailable: ${AI_EXTRACT_UNAVAILABLE_MSG}` })
        }
      }
      // The target returned an HTTP error but rendered → still a valid capture; surface
      // its status (header + a content note) so the agent can tell "site 404'd" from "we failed".
      if (r.pageStatus != null && r.pageStatus >= 400) {
        content.push({ type: 'text', text: `page_status: ${r.pageStatus}` })
      }
      // Quota headers on the successful response; flag a skipped extraction / page status.
      const mcpHeaders = quotaHeaders(quota.usage)
      if (mcpAiSkipped) mcpHeaders['X-Shotbase-AI-Skipped'] = 'monthly_quota_exceeded'
      if (r.pageStatus != null && r.pageStatus >= 400) mcpHeaders['X-Shotbase-Page-Status'] = String(r.pageStatus)
      return c.json(rpcResult(id, out), 200, mcpHeaders)
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
