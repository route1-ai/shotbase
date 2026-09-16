// Monthly quota enforcement (Phase C) — REST + MCP, Supabase-backed.
// Self-contained: spawns the backend + a stateful mock Supabase.
// Trick: requests use url=http://localhost/ so a quota-ALLOWED request short-circuits
// at the SSRF guard (400 "Blocked URL") — fast, no browser. Quota-BLOCKED → 429/isError
// before performCapture. So: 400 ⇒ allowed, 429 ⇒ blocked.
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value).

import http from 'node:http'
import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
const STATIC_KEY = 'teststatickey'
const PORT = 3962

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Mock Supabase (stateful) ─────────────────────────────────────────────────
const state = { usage: 0, plan: 'Free', failUsage: false, failPlan: false }
let lastCountQuery = '', lastUsersQuery = ''
const mock = http.createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (url.includes('/rest/v1/screenshots') && (req.method === 'HEAD' || req.method === 'GET')) {
      lastCountQuery = url
      if (state.failUsage) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'boom' })) }
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': `*/${state.usage}` }); return res.end('')
    }
    if (url.includes('/rest/v1/users') && req.method === 'GET') {
      lastUsersQuery = url
      if (state.failPlan) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'boom' })) }
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ plan: state.plan }))
    }
    if (url.includes('/rest/v1/screenshots') && req.method === 'POST') { res.writeHead(201); return res.end('[]') }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), PLAYGROUND_BYPASS_KEY: BYPASS, API_KEYS: STATIC_KEY, UNKEY_ROOT_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

const B = `http://localhost:${PORT}`
const LOCAL = 'http://localhost/' // SSRF-blocked → 400 when quota allows
// key: STATIC_KEY (owner 'static-key', plan free) OR BYPASS (needs X-Shotbase-User-Id → user plan lookup)
async function shot(key, uid) {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (uid) h['X-Shotbase-User-Id'] = uid
  const r = await fetch(`${B}/screenshot`, { method: 'POST', headers: h, body: JSON.stringify({ url: LOCAL }) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function mcp(key, uid) {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (uid) h['X-Shotbase-User-Id'] = uid
  const r = await fetch(`${B}/api/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: LOCAL } } }) })
  const j = await r.json()
  const t = (j?.result?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join(' ')
  return { isError: j?.result?.isError, text: t }
}

let up = false
for (let i = 0; i < 30; i++) { try { const h = await fetch(`${B}/health`); if (h.ok && (await h.json()).supabase === true) { up = true; break } } catch {} await sleep(500) }
if (!up) { bad('server failed to start / supabase not enabled'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // 1. Under limit (static key, free, usage 5) → allowed (400 Blocked URL, not 429)
  state.usage = 5; state.plan = 'Free'
  assert((await shot(STATIC_KEY)).status === 400, 'under limit → allowed (400 Blocked URL, not quota-blocked)')

  // 2. At/over free limit (usage 10000) → 429 REST + isError MCP
  state.usage = 10_000
  const over = await shot(STATIC_KEY)
  assert(over.status === 429 && over.body.error === 'Monthly quota exceeded' && over.body.limit === 10_000,
    `over free limit → 429 (limit=${over.body.limit}, used=${over.body.used})`)
  const overMcp = await mcp(STATIC_KEY)
  assert(overMcp.isError === true && /Monthly quota exceeded/.test(overMcp.text), `MCP over limit → isError "${overMcp.text.slice(0, 50)}"`)

  // 3a. Just under free limit (9999) → allowed
  state.usage = 9_999
  assert((await shot(STATIC_KEY)).status === 400, 'usage 9999 < 10000 free → allowed')

  // 3b. Plan tiers via bypass user plan lookup (pro = 250000)
  state.plan = 'pro'; state.usage = 100_000
  assert((await shot(BYPASS, 'user_pro')).status === 400, 'pro user @100k < 250k → allowed')
  state.usage = 250_000
  assert((await shot(BYPASS, 'user_pro')).status === 429, 'pro user @250k → blocked (per-plan limit via users.plan)')
  assert(lastUsersQuery.includes('clerk_id=eq.user_pro'), `bypass looked up user plan (users query: ${lastUsersQuery.slice(-40)})`)

  // 4. Accounting failure (count query errors) → fail closed 503 / MCP isError
  state.plan = 'Free'; state.usage = 5; state.failUsage = true
  const acct = await shot(STATIC_KEY)
  assert(acct.status === 503 && acct.body.error === 'Usage temporarily unavailable', `count-query failure → 503 fail-closed (got ${acct.status})`)
  const acctMcp = await mcp(STATIC_KEY)
  assert(acctMcp.isError === true && /temporarily unavailable/.test(acctMcp.text), `MCP accounting failure → isError "${acctMcp.text.slice(0, 40)}"`)
  state.failUsage = false

  // 4b. Bypass plan-lookup failure → fail closed too
  state.failPlan = true
  assert((await shot(BYPASS, 'user_x')).status === 503, 'bypass user-plan lookup failure → 503 fail-closed')
  state.failPlan = false

  // 5. User isolation + 6. cache hits counted (no cached filter in the count query)
  state.usage = 5
  await shot(STATIC_KEY)
  assert(lastCountQuery.includes('user_id=eq.static-key'), `count query is per-user (isolation): ${lastCountQuery.slice(-60)}`)
  assert(lastCountQuery.includes('created_at=gte.'), 'count query bounds to current month (created_at gte)')
  assert(!/cached=eq/.test(lastCountQuery), 'count query has NO cached filter → cache hits count toward quota')

  // 7. Concurrent near-limit race → quantify overshoot (non-atomic check)
  state.plan = 'Free'; state.usage = 9_999 // one slot left; mock count does not reflect in-flight
  const burst = await Promise.all(Array.from({ length: 5 }, () => shot(STATIC_KEY)))
  const admitted = burst.filter((r) => r.status === 400).length // 400 == passed quota
  assert(admitted > 1, `race: ${admitted}/5 admitted at limit-1 → overshoot = ${admitted - 1} (demonstrates non-atomic check)`)
  console.log(`  NOTE  measured overshoot at boundary under 5 concurrent = ${admitted - 1} extra`)
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
