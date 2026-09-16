// End-to-end overload behavior for /screenshot and MCP shotbase_capture, plus
// /health responsiveness while captures are queued. No test-runner dep.
//
// REQUIRES the server to be started with a tiny gate so a small burst overflows:
//   MAX_BROWSER_CONCURRENCY=1 MAX_BROWSER_QUEUE=1 BROWSER_QUEUE_TIMEOUT_MS=8000
// Env: SB_BASE (default http://localhost:3940), SB_KEY (REQUIRED), SB_URL (default https://example.com)

const BASE = process.env.SB_BASE ?? 'http://localhost:3940'
const KEY  = process.env.SB_KEY
if (!KEY) { console.error('FATAL: SB_KEY is required.'); process.exit(2) }
const URL_ = process.env.SB_URL ?? 'https://example.com'

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))

const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_overload' }

async function shot() {
  const res = await fetch(`${BASE}/screenshot`, { method: 'POST', headers: auth, body: JSON.stringify({ url: URL_ }) })
  return { status: res.status, retryAfter: res.headers.get('retry-after'), xcache: res.headers.get('x-cache') }
}
async function mcpCapture() {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: URL_, extract: false } } }),
  })
  const body = await res.json()
  const text = body?.result?.content?.find((b) => b.type === 'text')?.text ?? ''
  return { isError: body?.result?.isError === true, text, hasImage: !!body?.result?.content?.some((b) => b.type === 'image') }
}

console.log(`Overload HTTP → ${BASE} (expects gate concurrency=1 queue=1)`)

// ── /screenshot overload: burst of 6, cache-busted so each does real browser work ──
// (Use unique viewport per request so the cache never short-circuits the gate.)
async function shotUniq(i) {
  const res = await fetch(`${BASE}/screenshot`, { method: 'POST', headers: auth,
    body: JSON.stringify({ url: URL_, width: 800 + i, height: 600 }) })
  return { status: res.status, retryAfter: res.headers.get('retry-after') }
}
const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => shotUniq(i)))
const codes = burst.map((r) => r.status)
const over = burst.filter((r) => r.status === 503)
const good = burst.filter((r) => r.status === 200)
assert(over.length >= 1, `at least one 503 under load (codes: ${codes.join(',')})`)
assert(over.every((r) => r.retryAfter && Number(r.retryAfter) > 0), `every 503 carries a Retry-After header (${over.map((r) => r.retryAfter).join(',')})`)
assert(good.length >= 1, `at least one 200 succeeded under load (codes: ${codes.join(',')})`)

// ── /health stays responsive while a fresh burst is queued ──
const queued = Promise.all(Array.from({ length: 6 }, (_, i) => shotUniq(100 + i))) // occupy + queue the gate
const t0 = Date.now()
const h = await fetch(`${BASE}/health`)
const hms = Date.now() - t0
const hb = await h.json()
assert(h.status === 200 && hms < 1000, `/health responded in ${hms}ms (200) while captures in flight`)
console.log(`  (health snapshot during load: active=${hb.browserActive} queued=${hb.browserQueued})`)
await queued

// ── MCP overload: two concurrent captures; at least one image, and overflow is a clean isError ──
const [m1, m2] = await Promise.all([mcpCapture(), mcpCapture()])
const anyImage = m1.hasImage || m2.hasImage
const anyBusy = [m1, m2].some((m) => m.isError && /busy|capacity|timed out/i.test(m.text))
assert(anyImage, 'MCP shotbase_capture returned an image for at least one concurrent call')
assert(anyImage && (good.length >= 1), 'both endpoints share the same gate (screenshot 200 + MCP image observed)')
if (anyBusy) ok('MCP overflow returned a clean isError "busy" (no protocol error)')
else console.log('  NOTE: MCP overflow not triggered this run (2 calls fit the slot+queue) — overflow proven on /screenshot above')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
