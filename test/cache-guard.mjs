// Cache auth-guard + bounded in-memory cache.
//  - carriesTargetAuthMaterial(): true only when a request carries per-viewer auth
//    material for the target page (cookies / custom headers / target Authorization).
//  - boundedCacheSet(): caps the in-memory maps (oldest-out) and sweeps expired entries.
//  - Endpoint: today no route sets auth fields, so normal captures still cache (HIT) —
//    the guard is inert and the hit rate is unaffected.

import { spawn } from 'node:child_process'
import { carriesTargetAuthMaterial, boundedCacheSet } from '../dist/server.js'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── carriesTargetAuthMaterial ─────────────────────────────────────────────────
const base = { url: 'https://x', format: 'png', fullPage: false, width: 1440, height: 900, includeText: false, ownerId: 'u' }
assert(carriesTargetAuthMaterial(base) === false, 'plain capture → no auth material (false)')
assert(carriesTargetAuthMaterial({ ...base, blockAds: true, darkMode: true, delayMs: 500 }) === false, 'render options alone → false')
assert(carriesTargetAuthMaterial({ ...base, cookies: 'session=abc' }) === true, 'cookie string → true')
assert(carriesTargetAuthMaterial({ ...base, cookies: [{ name: 's', value: 'a' }] }) === true, 'cookie array → true')
assert(carriesTargetAuthMaterial({ ...base, cookies: { session: 'abc' } }) === true, 'cookie object → true')
assert(carriesTargetAuthMaterial({ ...base, cookies: '' }) === false, 'empty cookie string → false')
assert(carriesTargetAuthMaterial({ ...base, cookies: [] }) === false, 'empty cookie array → false')
assert(carriesTargetAuthMaterial({ ...base, cookies: {} }) === false, 'empty cookie object → false')
assert(carriesTargetAuthMaterial({ ...base, extraHeaders: { 'X-Auth': '1' } }) === true, 'custom header → true')
assert(carriesTargetAuthMaterial({ ...base, extraHeaders: {} }) === false, 'empty headers → false')
assert(carriesTargetAuthMaterial({ ...base, targetAuthorization: 'Bearer t' }) === true, 'target Authorization → true')
assert(carriesTargetAuthMaterial({ ...base, targetAuthorization: '   ' }) === false, 'blank target Authorization → false')

// ── boundedCacheSet: oldest-out eviction ──────────────────────────────────────
{
  const m = new Map()
  const now = Date.now()
  for (let i = 0; i < 3; i++) boundedCacheSet(m, `k${i}`, { v: i, timestamp: now }, now, 3)
  boundedCacheSet(m, 'k3', { v: 3, timestamp: now }, now, 3) // exceeds cap → evict oldest (k0)
  assert(m.size === 3, `cap enforced: size stays 3 (got ${m.size})`)
  assert(!m.has('k0') && m.has('k3') && m.has('k1') && m.has('k2'), 'oldest (k0) evicted, k1..k3 kept')
}

// ── boundedCacheSet: expired sweep on write ───────────────────────────────────
{
  const m = new Map()
  const now = Date.now()
  m.set('stale', { v: 0, timestamp: now - 61_000 }) // older than the 60s TTL
  m.set('fresh', { v: 1, timestamp: now })
  boundedCacheSet(m, 'new', { v: 2, timestamp: now }, now, 500)
  assert(!m.has('stale'), 'expired entry swept on write')
  assert(m.has('fresh') && m.has('new'), 'non-expired entries kept, new inserted')
}

// ── boundedCacheSet: updating an existing key does not evict ───────────────────
{
  const m = new Map()
  const now = Date.now()
  for (let i = 0; i < 3; i++) boundedCacheSet(m, `k${i}`, { v: i, timestamp: now }, now, 3)
  boundedCacheSet(m, 'k1', { v: 99, timestamp: now }, now, 3) // re-set existing at cap → no eviction
  assert(m.size === 3 && m.get('k1').v === 99 && m.has('k0'), 're-setting existing key at cap updates in place, no eviction')
}

// ── Endpoint: guard is inert today → normal captures still cache (HIT) ─────────
const KEY = 'cachekey'
const PORT = 3995
const child = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), API_KEYS: KEY, UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', REDIS_URL: '', AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => { try { child.kill('SIGKILL') } catch {} })
const B = `http://localhost:${PORT}`
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
async function shot(body) {
  const r = await fetch(`${B}/screenshot`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const ct = r.headers.get('content-type') || ''
  const json = ct.includes('application/json') ? await r.json() : null
  return { status: r.status, xcache: r.headers.get('x-cache'), cached: json?.cached, json }
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(`${B}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up())) { bad('server failed to start') }
else {
  const url = 'https://example.com/'
  const a = await shot({ url })
  const b = await shot({ url }) // identical → should hit the in-memory image cache
  assert(a.status === 200 && a.xcache === 'MISS', `plain capture #1 → 200 MISS (${a.status} ${a.xcache})`)
  assert(b.status === 200 && b.xcache === 'HIT', `plain capture #2 identical → HIT (guard inert, cache unaffected) (${b.status} ${b.xcache})`)

  const c = await shot({ url, include_text: true })
  const d = await shot({ url, include_text: true }) // identical data-mode → should hit the data cache
  assert(c.status === 200 && c.cached === false, `data capture #1 → 200 fresh (${c.status} cached=${c.cached})`)
  assert(d.status === 200 && d.cached === true, `data capture #2 identical → cached HIT (${d.status} cached=${d.cached})`)
}
try { child.kill('SIGKILL') } catch {}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
