// Error mapping for pages that fail to render. Two layers:
//  1) Unit tests of the pure classifier + message/status maps against the exact Chromium
//     error strings — deterministic, no network (real refused/TLS/timeout can't be
//     triggered against a local target without weakening the SSRF guard).
//  2) Integration: DNS + SSRF-block are deterministic (no network); the 4xx/5xx→200 +
//     X-Shotbase-Page-Status cases NEED a real HTTP-error response, so they hit stable
//     public endpoints (example.com 404, httpbin 500) — the only network-dependent asserts.

import http from 'node:http'
import { spawn } from 'node:child_process'
import { classifyCaptureError, captureFailMessage, CAPTURE_FAIL_STATUS } from '../dist/server.js'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1) classifyCaptureError: exact error strings → stable code ─────────────────
const CASES = [
  ['page.goto: net::ERR_NAME_NOT_RESOLVED at http://nope.example/', 'dns_failed'],
  ['page.goto: net::ERR_CERT_DATE_INVALID at https://expired.badssl.com/', 'ssl_error'],
  ['net::ERR_CERT_AUTHORITY_INVALID', 'ssl_error'],
  ['net::ERR_CERT_COMMON_NAME_INVALID', 'ssl_error'],
  ['net::ERR_SSL_PROTOCOL_ERROR', 'ssl_error'],
  ['page.goto: net::ERR_CONNECTION_REFUSED at http://x/', 'connection_refused'],
  ['net::ERR_CONNECTION_RESET', 'connection_refused'],
  ['net::ERR_CONNECTION_CLOSED', 'connection_refused'],
  ['net::ERR_ADDRESS_UNREACHABLE', 'connection_refused'],
  ['net::ERR_EMPTY_RESPONSE', 'connection_refused'],
  ['page.goto: Timeout 30000ms exceeded.', 'navigation_timeout'],
  ['Timeout 5000ms exceeded.', 'navigation_timeout'],
  ['some unexpected internal boom', 'render_failed'],
  ['', 'render_failed'],
]
for (const [msg, code] of CASES) {
  assert(classifyCaptureError(new Error(msg)) === code, `classify "${msg.slice(0, 42)}" → ${code}`)
}
// SSL is checked before the generic timeout branch (a cert error never mis-maps to timeout).
assert(classifyCaptureError(new Error('net::ERR_CERT_DATE_INVALID; Timeout 30000ms exceeded')) === 'ssl_error', 'cert+timeout string → ssl_error (cert wins)')
// Non-Error inputs don't throw.
assert(classifyCaptureError(undefined) === 'render_failed', 'undefined → render_failed')
assert(classifyCaptureError('net::ERR_CONNECTION_REFUSED') === 'connection_refused', 'raw string input classified')

// ── status map ────────────────────────────────────────────────────────────────
assert(CAPTURE_FAIL_STATUS.dns_failed === 400, 'dns_failed → 400')
assert(CAPTURE_FAIL_STATUS.connection_refused === 502, 'connection_refused → 502')
assert(CAPTURE_FAIL_STATUS.navigation_timeout === 504, 'navigation_timeout → 504')
assert(CAPTURE_FAIL_STATUS.ssl_error === 502, 'ssl_error → 502')
assert(CAPTURE_FAIL_STATUS.render_failed === 500, 'render_failed → 500')

// ── messages: useful + include the caller's own hostname ──────────────────────
assert(/Domain not found/.test(captureFailMessage('dns_failed', 'typo.example')) && captureFailMessage('dns_failed', 'typo.example').includes('typo.example'), 'dns message: "Domain not found" + hostname')
assert(captureFailMessage('connection_refused', 'h.example').includes('h.example'), 'connection message includes hostname')
assert(captureFailMessage('ssl_error', 'h.example').includes('h.example'), 'ssl message includes hostname')
assert(captureFailMessage('navigation_timeout', 'h.example').includes('h.example'), 'timeout message includes hostname')

// ── 2) Integration ─────────────────────────────────────────────────────────────
const KEY = 'errmapkey'
const PORT = 3970
const rows = []
const mock = http.createServer((req, res) => {
  const u = req.url || ''
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    if (u.includes('/rest/v1/screenshots') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': '*/0' }); return res.end('')
    }
    if (u.includes('/rest/v1/screenshots') && req.method === 'POST') {
      try { const p = JSON.parse(b); for (const r of Array.isArray(p) ? p : [p]) rows.push(r) } catch {}
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]')
    }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const child = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), API_KEYS: KEY, UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'test', REDIS_URL: '',
    AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)
const B = `http://localhost:${PORT}`
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
async function shot(url) {
  const res = await fetch(`${B}/screenshot`, { method: 'POST', headers: H, body: JSON.stringify({ url }), signal: AbortSignal.timeout(45000) })
  const ct = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, ct, bytes: buf.length, pageStatus: res.headers.get('x-shotbase-page-status'), json: ct.includes('json') ? JSON.parse(buf.toString()) : null }
}
async function rowFor(url, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { const m = rows.find((r) => r.url === url); if (m) return m; await sleep(150) } return null }
async function up() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up())) { bad('server failed to start') }
else {
  // DNS failure (deterministic: .invalid never resolves) → 400 dns_failed, NOT blocked, NO row.
  {
    const url = `http://does-not-exist-${Date.now()}.invalid/`
    const before = rows.length
    const r = await shot(url)
    await sleep(400)
    assert(r.status === 400 && r.json?.code === 'dns_failed', `DNS typo → 400 code:dns_failed (${r.status} ${r.json?.code})`)
    assert(/Domain not found/.test(r.json?.error || '') && (r.json?.error || '').includes('.invalid'), `dns message useful + hostname ("${r.json?.error}")`)
    assert(!/Call log|\.ts:|\/Users\/|at Object|node:internal/.test(JSON.stringify(r.json)), 'no raw error / stack / path leaked')
    assert(!rows.some((x) => x.url === url) && rows.length === before, 'failed DNS render logged NO status-200 row → not counted against quota')
  }
  // SSRF block stays distinct (deterministic: private IP literal) → 400 blocked_url.
  {
    const r = await shot('http://127.0.0.1/')
    assert(r.status === 400 && r.json?.code === 'blocked_url' && r.json?.error === 'Blocked URL', `private IP → 400 code:blocked_url (distinct from dns_failed) (${r.status} ${r.json?.code})`)
  }
  // 4xx page (NETWORK): renders → 200 PNG + X-Shotbase-Page-Status:404 + counts as a capture.
  {
    const url = `https://example.com/nope-${Date.now()}`
    const r = await shot(url)
    assert(r.status === 200 && r.ct.startsWith('image/'), `4xx target → 200 image (${r.status} ${r.ct})`)
    assert(r.pageStatus === '404', `X-Shotbase-Page-Status: 404 (${r.pageStatus})`)
    const row = await rowFor(url)
    assert(row && row.status === 200, 'rendered 4xx page logged status-200 row → COUNTS as a capture (documented)')
  }
  // 5xx empty-body page (NETWORK): guard skipped → still 200 + X-Shotbase-Page-Status:500.
  {
    const r = await shot('https://httpbin.org/status/500')
    assert(r.status === 200 && r.ct.startsWith('image/') && r.pageStatus === '500', `empty 5xx target → 200 image + X-Shotbase-Page-Status:500 (${r.status} ${r.pageStatus})`)
  }
}
cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
