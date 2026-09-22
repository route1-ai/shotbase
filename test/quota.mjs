// Monthly quota enforcement (Pricing v2, DUAL quota) — REST + MCP, Supabase-backed.
// Self-contained: spawns the backend + a stateful mock Supabase.
//
// Trick: requests use url=http://localhost/ so a quota-ALLOWED request short-circuits
// at the SSRF guard (REST 400 "Blocked URL"; MCP isError "Blocked URL") — fast, no
// browser, no real Bedrock. A quota-BLOCKED request returns 429 / a quota isError
// BEFORE performCapture. So for REST: 400 ⇒ allowed, 429 ⇒ blocked. For MCP we read
// the isError text: "Blocked URL" ⇒ allowed, "quota exceeded" ⇒ blocked.
//
// INVALID (but present) AWS creds are set so bedrockClient initializes — that lets an
// ai_extract REST request reach the AI-quota check instead of the "needs credentials"
// 400. Bedrock is never actually called (SSRF/quota short-circuit first).
//
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value).

import http from 'node:http'
import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
// Free plan is 10 rpm. This test fires many requests, so give each static-key
// request its OWN api key (all map to owner 'static-key', plan free) → separate
// rate-limit buckets, so RPM never masks the quota behavior under test.
const STATIC_KEYS = Array.from({ length: 300 }, (_, i) => `sk${i}`)
let staticN = 0
const nextStatic = () => STATIC_KEYS[staticN++]
const PORT = 3962
const PORT_NOSB = 3963

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Mock Supabase (stateful, dual usage) ─────────────────────────────────────
// A screenshots count query with `ai_succeeded=eq.true` → AI usage; otherwise capture.
const state = { capture: 0, ai: 0, plan: 'Free', failCapture: false, failAi: false, failPlan: false }
let lastCaptureQuery = '', lastAiQuery = '', lastUsersQuery = ''
const mock = http.createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (url.includes('/rest/v1/screenshots') && (req.method === 'HEAD' || req.method === 'GET')) {
      const isAi = url.includes('ai_succeeded=eq.true')
      if (isAi) {
        lastAiQuery = url
        if (state.failAi) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'boom' })) }
        res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': `*/${state.ai}` }); return res.end('')
      }
      lastCaptureQuery = url
      if (state.failCapture) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: 'boom' })) }
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': `*/${state.capture}` }); return res.end('')
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

const AWS_INVALID = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAINVALIDTESTKEY000', AWS_SECRET_ACCESS_KEY: 'invalidsecret0000000000000000000000000000' }

// Server WITH Supabase (quota enforced)
const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env, ...AWS_INVALID, PORT: String(PORT), PLAYGROUND_BYPASS_KEY: BYPASS, API_KEYS: STATIC_KEYS.join(','), UNKEY_ROOT_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-service',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
// Server WITHOUT Supabase (quota disabled — dev/self-host behavior)
const childNoSb = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT_NOSB), PLAYGROUND_BYPASS_KEY: BYPASS, API_KEYS: STATIC_KEYS.join(','), UNKEY_ROOT_KEY: '',
    SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { for (const ch of [child, childNoSb]) { try { ch.kill('SIGKILL') } catch {} } try { mock.close() } catch {} }
process.on('exit', cleanup)

const B = `http://localhost:${PORT}`
const BN = `http://localhost:${PORT_NOSB}`
const LOCAL = 'http://localhost/' // SSRF-blocked → "allowed" sentinel when quota passes

// key: STATIC_KEY (owner 'static-key', plan free) OR BYPASS (needs X-Shotbase-User-Id → users.plan)
async function shot(base, key, uid, extra = {}) {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (uid) h['X-Shotbase-User-Id'] = uid
  const r = await fetch(`${base}/screenshot`, { method: 'POST', headers: h, body: JSON.stringify({ url: LOCAL, ...extra }) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function mcp(base, key, uid, extract) {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (uid) h['X-Shotbase-User-Id'] = uid
  const args = { url: LOCAL }
  if (extract !== undefined) args.extract = extract
  const r = await fetch(`${base}/api/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shotbase_capture', arguments: args } }) })
  const j = await r.json()
  const t = (j?.result?.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join(' ')
  return { isError: j?.result?.isError, text: t }
}
const AI = { ai_extract: { page_type: true } }              // real AI request
const AI_ALLFALSE = { ai_extract: { page_type: false, prices: false } } // NOT an AI request

async function waitUp(base, needSb) {
  // /health now returns 200 { status:"ok" } only when its subsystem checks pass
  // (Supabase connectivity gates it when configured), so h.ok is the readiness signal.
  for (let i = 0; i < 60; i++) { try { const h = await fetch(`${base}/health`); if (h.ok) return await h.json() } catch {} await sleep(500) }
  return null
}

const h1 = await waitUp(B, true)
const h2 = await waitUp(BN, false)
if (!h1) { bad('server (with supabase) failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }
if (!h2) { bad('server (no supabase) failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // ── CAPTURE QUOTA (free = 250) ─────────────────────────────────────────────
  console.log('── capture quota (free = 250) ──')
  state.capture = 5; state.ai = 0; state.plan = 'Free'
  assert((await shot(B, nextStatic())).status === 400, 'free @5 captures → allowed (400 Blocked URL)')

  state.capture = 249
  assert((await shot(B, nextStatic())).status === 400, 'free @249 < 250 → allowed')

  state.capture = 250
  const capOver = await shot(B, nextStatic())
  assert(capOver.status === 429 && capOver.body.error === 'Monthly capture quota exceeded'
    && capOver.body.quota_type === 'captures' && capOver.body.limit === 250 && capOver.body.used === 250,
    `free @250 → 429 capture quota (error="${capOver.body.error}", quota_type=${capOver.body.quota_type}, limit=${capOver.body.limit})`)

  const capOverMcp = await mcp(B, nextStatic(), null, false)
  assert(capOverMcp.isError === true && /Monthly capture quota exceeded/.test(capOverMcp.text),
    `MCP extract=false @250 → isError capture quota "${capOverMcp.text.slice(0, 45)}"`)

  // ── AI QUOTA (free = 25) — capture under limit ─────────────────────────────
  console.log('── AI extraction quota (free = 25) ──')
  state.capture = 5; state.ai = 24
  assert((await shot(B, nextStatic(), null, AI)).status === 400, 'AI @24 < 25, capture ok → AI request allowed')

  state.ai = 25
  const aiOver = await shot(B, nextStatic(), null, AI)
  assert(aiOver.status === 429 && aiOver.body.error === 'Monthly AI extraction quota exceeded'
    && aiOver.body.quota_type === 'ai_extractions' && aiOver.body.limit === 25 && aiOver.body.used === 25,
    `AI @25 → 429 AI quota (error="${aiOver.body.error}", quota_type=${aiOver.body.quota_type}, limit=${aiOver.body.limit})`)

  // AI exhausted but request has NO ai / all-false ai → capture-only → allowed
  assert((await shot(B, nextStatic())).status === 400, 'AI exhausted, plain capture (no ai_extract) → allowed (AI quota not checked)')
  assert((await shot(B, nextStatic(), null, AI_ALLFALSE)).status === 400,
    'AI exhausted, ai_extract all-false → allowed (all-false is NOT an AI request)')

  // include_text does NOT consume AI allowance → allowed even with AI exhausted
  assert((await shot(B, nextStatic(), null, { include_text: true })).status === 400,
    'AI exhausted, include_text:true → allowed (include_text does not use AI quota)')

  // Capture exhausted takes precedence over AI exhausted
  state.capture = 250; state.ai = 25
  const both = await shot(B, nextStatic(), null, AI)
  assert(both.status === 429 && both.body.quota_type === 'captures',
    `both exhausted + AI request → capture quota wins (quota_type=${both.body.quota_type})`)

  // ── MCP dual quota ─────────────────────────────────────────────────────────
  console.log('── MCP extract=true needs BOTH quotas; extract=false needs only capture ──')
  state.capture = 5; state.ai = 25
  const mAiBlock = await mcp(B, nextStatic(), null, true)
  assert(mAiBlock.isError === true && /Monthly AI extraction quota exceeded/.test(mAiBlock.text),
    `MCP extract=true, AI exhausted → isError AI quota "${mAiBlock.text.slice(0, 45)}"`)
  const mCapOk = await mcp(B, nextStatic(), null, false)
  assert(mCapOk.isError === true && /Blocked URL/.test(mCapOk.text),
    `MCP extract=false, AI exhausted, capture ok → allowed (reaches SSRF, "${mCapOk.text.slice(0, 30)}")`)

  // ── Effective plan via bypass (THE playground bug fix) ─────────────────────
  console.log('── playground bypass uses REAL plan, not the pro placeholder ──')
  // Bypass key authenticates as 'pro' internally; real user plan is Free. Usage 300 is
  // over the Free cap (250) but under Pro (7500). If the placeholder leaked, this would
  // be allowed. It must be BLOCKED as Free.
  state.plan = 'Free'; state.capture = 300; state.ai = 0
  const pgFree = await shot(B, BYPASS, 'user_free')
  assert(pgFree.status === 429 && pgFree.body.limit === 250,
    `bypass Free user @300 → 429 at Free cap 250 (limit=${pgFree.body.limit}) — real plan used, not pro placeholder`)
  assert(lastUsersQuery.includes('clerk_id=eq.user_free'), `bypass looked up real plan (users query: ${lastUsersQuery.slice(-38)})`)

  state.plan = 'pro'; state.capture = 7_499
  assert((await shot(B, BYPASS, 'user_pro')).status === 400, 'bypass Pro user @7499 < 7500 → allowed')
  state.capture = 7_500
  const pgPro = await shot(B, BYPASS, 'user_pro')
  assert(pgPro.status === 429 && pgPro.body.limit === 7_500, `bypass Pro user @7500 → 429 at Pro cap 7500 (limit=${pgPro.body.limit})`)

  // legacy 'scale' normalizes to pro; 'starter' to builder
  state.plan = 'scale'; state.capture = 7_499
  assert((await shot(B, BYPASS, 'user_scale')).status === 400, "legacy 'scale' user @7499 → allowed (normalized to pro, cap 7500)")
  state.plan = 'starter'; state.capture = 1_500
  const stOver = await shot(B, BYPASS, 'user_starter')
  assert(stOver.status === 429 && stOver.body.limit === 1_500, "legacy 'starter' user @1500 → 429 (normalized to builder, cap 1500)")

  // ── Count-query shape (sections 4 & 5) ──────────────────────────────────────
  console.log('── count query shape ──')
  state.plan = 'Free'; state.capture = 5; state.ai = 0
  await shot(B, nextStatic(), null, AI) // fires both capture + AI count queries
  assert(lastCaptureQuery.includes('user_id=eq.static-key'), `capture count is per-user: ${lastCaptureQuery.slice(-70)}`)
  assert(lastCaptureQuery.includes('status=eq.200'), 'capture count filters status=200 (failures excluded)')
  assert(lastCaptureQuery.includes('created_at=gte.'), 'capture count bounds to current UTC month')
  assert(!/cached=eq/.test(lastCaptureQuery), 'capture count has NO cached filter → cache hits count')
  assert(lastAiQuery.includes('status=eq.200') && lastAiQuery.includes('ai_succeeded=eq.true'),
    `AI count filters status=200 AND ai_succeeded=true: ${lastAiQuery.slice(-70)}`)

  // ── Fail-closed (accounting query failures) ─────────────────────────────────
  console.log('── fail closed on accounting failure ──')
  state.capture = 5; state.ai = 0; state.failCapture = true
  const acct = await shot(B, nextStatic())
  assert(acct.status === 503 && acct.body.error === 'Usage temporarily unavailable', `capture-count failure → 503 fail-closed (got ${acct.status})`)
  const acctMcp = await mcp(B, nextStatic(), null, false)
  assert(acctMcp.isError === true && /temporarily unavailable/.test(acctMcp.text), `MCP capture-count failure → isError "${acctMcp.text.slice(0, 40)}"`)
  state.failCapture = false

  state.failAi = true
  const acctAi = await shot(B, nextStatic(), null, AI)
  assert(acctAi.status === 503, 'AI-count failure (on AI request) → 503 fail-closed')
  assert((await shot(B, nextStatic())).status === 400, 'AI-count failure does NOT affect capture-only request (still allowed)')
  state.failAi = false

  state.failPlan = true
  assert((await shot(B, BYPASS, 'user_x')).status === 503, 'bypass plan-lookup failure → 503 fail-closed')
  state.failPlan = false

  // ── Supabase UNCONFIGURED → quota disabled (dev/self-host) ──────────────────
  console.log('── supabase unconfigured preserves quota-disabled dev behavior ──')
  assert(h2?.status === 'ok', `no-supabase server is healthy (status=${h2?.status})`)
  // Even an AI request (which would need both quotas) is allowed → reaches SSRF 400.
  assert((await shot(BN, nextStatic(), null, { include_text: false })).status === 400, 'no-supabase: plain request → allowed (quota disabled)')
  const nosbMcp = await mcp(BN, nextStatic(), null, true)
  assert(nosbMcp.isError === true && /Blocked URL/.test(nosbMcp.text), `no-supabase: MCP extract=true → reaches SSRF (quota disabled) "${nosbMcp.text.slice(0, 30)}"`)
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
