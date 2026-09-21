// Full-page scroll prepass — INTEGRATION (real backend + browser + network).
// Self-contained: spawns the backend + a mock Supabase that captures inserted rows.
// Proves: prepass runs only for full_page=true; viewport captures unchanged; a
// prepass THROW degrades gracefully AND releases the BrowserGate permit; one
// successful capture is logged exactly once.
//
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value). Uses https://example.com (network +
// local Playwright browser).

import http from 'node:http'
import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
const URL_ = process.env.SB_URL ?? 'https://example.com'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Mock Supabase: capture inserted rows; usage 0; bypass plan 'pro' ──────────
const rows = []
const mock = http.createServer((req, res) => {
  const u = req.url || ''
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.method === 'POST' && u.includes('/rest/v1/screenshots')) {
      try { const p = JSON.parse(body); for (const r of Array.isArray(p) ? p : [p]) rows.push(r) } catch {}
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]')
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && u.includes('/rest/v1/screenshots')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': '*/0' }); return res.end('')
    }
    if (req.method === 'GET' && u.includes('/rest/v1/users')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ plan: 'pro' }))
    }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

function startServer(port, extraEnv = {}) {
  const child = spawn('node', ['dist/server.js'], {
    env: {
      ...process.env, PORT: String(port), PLAYGROUND_BYPASS_KEY: BYPASS, UNKEY_ROOT_KEY: '',
      SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-service',
      MAX_BROWSER_CONCURRENCY: '2', MAX_BROWSER_QUEUE: '5', ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  return child
}
let child = startServer(3971)
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

const hdr = (uid) => ({ Authorization: `Bearer ${BYPASS}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': uid })
async function shotJson(base, uid, extra) {
  const r = await fetch(`${base}/screenshot`, { method: 'POST', headers: hdr(uid), body: JSON.stringify({ url: URL_, include_text: true, ...extra }), signal: AbortSignal.timeout(60000) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function shotImg(base, uid, extra) {
  const r = await fetch(`${base}/screenshot`, { method: 'POST', headers: hdr(uid), body: JSON.stringify({ url: URL_, ...extra }), signal: AbortSignal.timeout(60000) })
  const buf = Buffer.from(await r.arrayBuffer())
  return { status: r.status, ct: r.headers.get('content-type'), bytes: buf.length, steps: r.headers.get('x-fullpage-scroll-steps'), initH: r.headers.get('x-fullpage-initial-height') }
}
async function waitUp(base) {
  for (let i = 0; i < 40; i++) { try { const h = await fetch(`${base}/health`); if (h.ok && (await h.json()).supabase === true) return true } catch {} await sleep(500) }
  return false
}
async function gateIdle(base) {
  const h = await (await fetch(`${base}/health`)).json()
  return h.browserActive === 0 && h.browserQueued === 0
}

const B = 'http://localhost:3971'
if (!(await waitUp(B))) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // 1 & 2) prepass gating — cache-busted per request (include_text is never cached)
  const off = await shotJson(B, 'user_off', { full_page: false, width: 800, height: 600 })
  assert(off.status === 200 && off.body.timings && off.body.timings.fullPageScrollMs === undefined,
    `full_page=false → prepass NOT run (no fullPageScrollMs key; status=${off.status})`)

  const on = await shotJson(B, 'user_on', { full_page: true, width: 800, height: 600 })
  const t = on.body.timings || {}
  assert(on.status === 200 && typeof t.fullPageScrollMs === 'number' && typeof t.fullPageInitialHeight === 'number' && typeof t.fullPageScrollSteps === 'number',
    `full_page=true → prepass RAN (fullPageScrollMs=${t.fullPageScrollMs}, steps=${t.fullPageScrollSteps}, initH=${t.fullPageInitialHeight})`)

  // 8) viewport image unchanged + header wiring
  const imgOff = await shotImg(B, 'user_imgoff', { full_page: false, width: 820, height: 600 })
  assert(imgOff.status === 200 && imgOff.ct?.startsWith('image/') && imgOff.bytes > 1000 && imgOff.steps === null,
    `viewport (full_page=false) → 200 image, no X-FullPage headers (bytes=${imgOff.bytes}, steps hdr=${imgOff.steps})`)
  const imgOn = await shotImg(B, 'user_imgon', { full_page: true, width: 821, height: 600 })
  assert(imgOn.status === 200 && imgOn.ct?.startsWith('image/') && imgOn.steps !== null,
    `full_page=true image → 200 with X-FullPage-Scroll-Steps header (=${imgOn.steps}, initH=${imgOn.initH})`)

  // 10) exactly one log row per successful capture
  const before = rows.filter((r) => r.user_id === 'user_count').length
  await shotImg(B, 'user_count', { full_page: true, width: 822, height: 600 })
  await sleep(800)
  const after = rows.filter((r) => r.user_id === 'user_count').length
  assert(after - before === 1, `one full_page capture → exactly one usage row (delta=${after - before})`)

  // gate must be idle after all the above (permits released on the normal prepass path)
  assert(await gateIdle(B), 'BrowserGate drained to 0 after normal full-page captures')

  // NOTE: prepass-FAILURE handling (graceful degradation + BrowserGate permit
  // release + no slot leak + subsequent request works) is proven in
  // test/fullpage-scroll.mjs (cases K/L) by injecting a throwing prepass function
  // into the real runScrollPrepass wrapper + real BrowserGate — no production
  // failure lever required.
} finally {
  child.kill('SIGKILL'); await sleep(400)
}

cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
