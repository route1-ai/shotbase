// Unified error codes — every error response across the API carries a stable `code`.
// Quota checks run BEFORE performCapture, and auth/validation/rate errors run before
// SSRF/network, so almost everything here is deterministic with no real captures.
// Two servers: A has no AWS creds (bedrockClient null → tests ai_extraction_unavailable);
// B has invalid-but-present AWS creds (bedrockClient set → tests ai_quota_exceeded).

import http from 'node:http'
import { spawn } from 'node:child_process'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── In-process mock Supabase (shared by both servers); counts toggled per sub-test ──
let captureCount = 0, aiCount = 0, failMode = false
const mock = http.createServer((req, res) => {
  const u = req.url || ''
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    if (u.includes('/rest/v1/screenshots') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (failMode) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"boom"}') }
      const ai = u.includes('ai_succeeded=eq.true')
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': `*/${ai ? aiCount : captureCount}` }); return res.end('')
    }
    if (u.includes('/rest/v1/screenshots') && req.method === 'POST') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]') }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port
const KEYS = 'k_val,k_ai,k_block,k_dns,k_quota,k_acct,k_rate,k_aiq'
function startServer(port, extra) {
  return spawn('node', ['dist/server.js'], {
    env: { ...process.env, PORT: String(port), API_KEYS: KEYS, UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '',
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test', REDIS_URL: '', MAX_BODY_BYTES: '1024', ...extra },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
const A = startServer(3980, { AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' })
const B = startServer(3981, { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAINVALIDTEST00000', AWS_SECRET_ACCESS_KEY: 'invalidsecret000000000000000000000000000' })
function cleanup() { for (const c of [A, B]) { try { c.kill('SIGKILL') } catch {} } try { mock.close() } catch {} }
process.on('exit', cleanup)

const BA = 'http://localhost:3980', BB = 'http://localhost:3981'
async function call(base, { key, body, headers } = {}) {
  const h = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(headers || {}) }
  const res = await fetch(`${base}/screenshot`, { method: 'POST', headers: h, body: body ?? '{}', signal: AbortSignal.timeout(20000) })
  const j = await res.json().catch(() => null)
  return { status: res.status, code: j?.code, error: j?.error }
}
async function up(base) { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up(BA)) || !(await up(BB))) { bad('server(s) failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // request_too_large (bodyLimit fires before auth) — body > MAX_BODY_BYTES (min 1024)
  {
    const big = JSON.stringify({ url: 'https://example.com/' + 'x'.repeat(1400) })
    const res = await fetch(`${BA}/screenshot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: big })
    const j = await res.json().catch(() => null)
    assert(res.status === 413 && j?.code === 'request_too_large', `413 → code:request_too_large (${res.status} ${j?.code})`)
  }
  // auth
  assert((await call(BA, {})).code === 'missing_authorization', 'no Authorization → missing_authorization')
  assert((await call(BA, { headers: { Authorization: 'Token abc' } })).code === 'invalid_authorization', 'malformed Authorization → invalid_authorization')
  assert((await call(BA, { key: 'not-a-real-key' })).code === 'invalid_api_key', 'bad key → invalid_api_key')
  // validation (k_val, <10 requests)
  assert((await call(BA, { key: 'k_val', body: '{}' })).code === 'invalid_url', 'missing url → invalid_url')
  assert((await call(BA, { key: 'k_val', body: JSON.stringify({ url: 'https://x.example', format: 'gif' }) })).code === 'invalid_parameter', 'bad format → invalid_parameter')
  assert((await call(BA, { key: 'k_val', body: JSON.stringify({ url: 'https://x.example', width: 5 }) })).code === 'invalid_parameter', 'bad width → invalid_parameter')
  assert((await call(BA, { key: 'k_val', body: JSON.stringify({ url: 'https://x.example', ai_extract: [] }) })).code === 'invalid_parameter', 'ai_extract array → invalid_parameter')
  // ai_extraction_unavailable (server A: no bedrock client)
  assert((await call(BA, { key: 'k_ai', body: JSON.stringify({ url: 'https://x.example', ai_extract: { page_type: true } }) })).code === 'ai_extraction_unavailable', 'ai_extract w/o bedrock → ai_extraction_unavailable')
  // blocked_url + dns_failed
  assert((await call(BA, { key: 'k_block', body: JSON.stringify({ url: 'http://127.0.0.1/' }) })).code === 'blocked_url', 'private IP → blocked_url')
  assert((await call(BA, { key: 'k_dns', body: JSON.stringify({ url: `http://nope-${Date.now()}.invalid/` }) })).code === 'dns_failed', 'bad domain → dns_failed')
  // capture_quota_exceeded (quota checked before any capture; no network)
  captureCount = 999999
  assert((await call(BA, { key: 'k_quota', body: JSON.stringify({ url: 'https://x.example' }) })).code === 'capture_quota_exceeded', 'capture quota full → capture_quota_exceeded')
  captureCount = 0
  // usage_unavailable (accounting query fails)
  failMode = true
  assert((await call(BA, { key: 'k_acct', body: JSON.stringify({ url: 'https://x.example' }) })).code === 'usage_unavailable', 'accounting down → usage_unavailable')
  failMode = false
  // rate_limited (free rpm=10; fire 12 on one key, all missing-url so no capture)
  {
    const results = []
    for (let i = 0; i < 12; i++) results.push(await call(BA, { key: 'k_rate', body: '{}' }))
    const limited = results.filter((r) => r.status === 429 && r.code === 'rate_limited')
    const validated = results.filter((r) => r.status === 400 && r.code === 'invalid_url')
    assert(limited.length >= 1 && validated.length >= 1, `rate limit → some rate_limited(429) after some invalid_url(400) (429s=${limited.length}, 400s=${validated.length})`)
  }
  // ai_quota_exceeded (server B: bedrock client present, ai-only request, ai count full)
  captureCount = 0; aiCount = 999999
  {
    const r = await call(BB, { key: 'k_aiq', body: JSON.stringify({ url: 'https://x.example', ai_extract: { page_type: true } }) })
    assert(r.status === 429 && r.code === 'ai_quota_exceeded', `AI quota full (ai-only) → ai_quota_exceeded (${r.status} ${r.code})`)
  }
  aiCount = 0
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
