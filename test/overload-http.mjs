// Deterministic end-to-end overload behavior for /screenshot and MCP shotbase_capture,
// plus /health responsiveness while the browser gate is full. No test-runner dep.
//
// Determinism (fixes the old race that depended on example.com's latency): the gate is
// filled by the TEST-ONLY occupier route POST /__gate/occupy (enabled with
// SHOTBASE_TEST_GATE_OCCUPY=1), which acquires real gate permits and holds them for a
// bounded time — no capture, no navigation, no SSRF. With the gate held full, real
// /screenshot and MCP requests deterministically overflow. Those requests target a
// RESERVED, non-routable IP (198.51.100.1, TEST-NET-2): it passes the SSRF guard without
// a DNS lookup, and because the gate is full they are rejected before any network I/O —
// so there is no public internet in the assertion path.
//
// Property under test: gate full → 503 with a positive Retry-After (REST) / "Server busy"
// isError (MCP); /health still answers <1s; and /screenshot + MCP share one gate. Phases
// drain the gate between them. Also asserts the occupier route is ABSENT when unset, and
// that the server refuses to boot with the lever set under NODE_ENV=production.
//
// Env: SB_KEY (REQUIRED — the bypass key the backend is started with).

import { spawn } from 'node:child_process'

const KEY = process.env.SB_KEY
if (!KEY) { console.error('FATAL: SB_KEY is required.'); process.exit(2) }

const CONC = 1, QUEUE = 1, CAPACITY = CONC + QUEUE, TIMEOUT_MS = 8000
const HOLD = 2500       // ms each occupier holds a gate permit
const RESERVED = 'http://198.51.100.1/' // TEST-NET-2: passes SSRF, never routes
const PORT = 3948
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startServer(port, extraEnv) {
  return spawn('node', ['dist/server.js'], {
    env: {
      ...process.env, PORT: String(port), PLAYGROUND_BYPASS_KEY: KEY, API_KEYS: '', UNKEY_ROOT_KEY: '',
      SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '', REDIS_URL: '',
      MAX_BROWSER_CONCURRENCY: String(CONC), MAX_BROWSER_QUEUE: String(QUEUE), BROWSER_QUEUE_TIMEOUT_MS: String(TIMEOUT_MS),
      ...extraEnv,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
const child = startServer(PORT, { SHOTBASE_TEST_GATE_OCCUPY: '1' })
function cleanup() { try { child.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)

const B = `http://localhost:${PORT}`
const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_overload' }

// occupy: hold a gate permit for ms (bounded server-side at 5s). Returns 200 when it
// acquired, or 503 if the gate was already full.
async function occupy(ms) {
  const res = await fetch(`${B}/__gate/occupy`, { method: 'POST', headers: auth, body: JSON.stringify({ ms }), signal: AbortSignal.timeout(15000) })
  return { status: res.status, retryAfter: res.headers.get('retry-after') }
}
async function shot(id) {
  const res = await fetch(`${B}/screenshot`, { method: 'POST', headers: auth, body: JSON.stringify({ url: `${RESERVED}?id=${id}` }), signal: AbortSignal.timeout(15000) })
  return { status: res.status, retryAfter: res.headers.get('retry-after') }
}
async function mcp(id) {
  const res = await fetch(`${B}/api/mcp`, {
    method: 'POST', headers: auth, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: `${RESERVED}?id=${id}`, extract: false } } }),
  })
  const body = await res.json()
  const c = body?.result?.content ?? []
  return { isError: body?.result?.isError === true, text: c.find((b) => b.type === 'text')?.text ?? '' }
}
// Fill the gate (1 active + 1 queued occupier) and return the in-flight promises to await.
function fillGate() {
  return [occupy(HOLD), occupy(HOLD)]
}
// Drain: poll a 0ms occupier until it acquires (200) → the gate is free again.
async function drain() {
  for (let i = 0; i < 40; i++) {
    const r = await occupy(0).catch(() => ({ status: 0 }))
    if (r.status === 200) return
    await sleep(200)
  }
  console.log('  WARN: gate did not drain within timeout')
}
async function up(base) { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${base}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up(B))) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }
console.log(`Overload HTTP → ${B} (gate concurrency=${CONC} queue=${QUEUE}, occupier route)`)

try {
  // Baseline: gate empty → occupier acquires immediately (200). Proves the gate GRANTS
  // when free, so a later 503 is specifically overload, not a blanket rejection.
  {
    const r = await occupy(0)
    assert(r.status === 200, `gate free → occupier acquires (200), not a blanket reject (${r.status})`)
  }
  await drain()

  // ── Phase 1: /screenshot overflow — 4 into a full capacity-2 gate → ≥2× 503 ──
  {
    const held = fillGate()
    await sleep(500) // let 1 active + 1 queued occupier settle → gate full
    const burst = await Promise.all(Array.from({ length: 4 }, (_, i) => shot(`p1_${i}`)))
    const codes = burst.map((r) => r.status)
    const over = burst.filter((r) => r.status === 503)
    assert(over.length >= 2, `≥2 of 4 /screenshot requests rejected 503 while gate full (codes: ${codes.join(',')})`)
    assert(over.length > 0 && over.every((r) => r.retryAfter && Number(r.retryAfter) > 0), `every 503 carries a positive Retry-After (${over.map((r) => r.retryAfter).join(',')})`)
    await Promise.all(held)
  }
  await drain()

  // ── Phase 2: /health stays responsive (<1s) while the gate is saturated ──
  {
    const held = fillGate()
    await sleep(500)
    const t0 = Date.now()
    const h = await fetch(`${B}/health`)
    const hms = Date.now() - t0
    const hb = await h.json().catch(() => ({}))
    assert(h.status === 200 && hms < 1000, `/health → 200 in ${hms}ms while gate full (status=${hb.status})`)
    await Promise.all(held)
  }
  await drain()

  // ── Phase 3: MCP overflow — sized ABOVE capacity → overflow actually occurs ──
  {
    const held = fillGate()
    await sleep(500)
    const res = await Promise.all(Array.from({ length: 4 }, (_, i) => mcp(`p3_${i}`)))
    const busy = res.filter((r) => r.isError && /busy|capacity|timed out/i.test(r.text))
    assert(busy.length >= 2, `≥2 of 4 MCP captures overflowed with a clean "Server busy" isError (got ${busy.length})`)
    await Promise.all(held)
  }
  await drain()

  // ── Phase 4: /screenshot and MCP share ONE gate ──
  // The occupier is neither endpoint, yet holding the gate blocks BOTH → they share it.
  {
    const held = fillGate()
    await sleep(500)
    const [s, m] = await Promise.all([shot('p4_rest'), mcp('p4_mcp')])
    assert(s.status === 503 && s.retryAfter && Number(s.retryAfter) > 0, `gate held → /screenshot rejected 503 (${s.status})`)
    assert(m.isError && /busy|capacity|timed out/i.test(m.text), `gate held → MCP rejected "Server busy" (${m.text.slice(0, 30)})`)
    ok('shared gate proven: a non-capture occupier blocks BOTH /screenshot and MCP')
    await Promise.all(held)
  }
  await drain()
} finally { cleanup() }

// ── Aux 1: occupier route is ABSENT when the lever is unset (not merely 404-in-handler) ──
{
  const p2 = 3949
  const s2 = startServer(p2, {}) // no SHOTBASE_TEST_GATE_OCCUPY
  try {
    if (!(await up(`http://localhost:${p2}`))) bad('aux server failed to start')
    else {
      const r = await fetch(`http://localhost:${p2}/__gate/occupy`, { method: 'POST', headers: auth, body: '{"ms":100}' })
      assert(r.status === 404, `lever unset → POST /__gate/occupy is 404 (route not registered) (${r.status})`)
      // sanity: the same server's real routes still exist
      const h = await fetch(`http://localhost:${p2}/health`)
      assert(h.status === 200, `aux server otherwise healthy (${h.status})`)
    }
  } finally { try { s2.kill('SIGKILL') } catch {} }
}

// ── Aux 2: lever set under NODE_ENV=production → HARD boot failure, not a silent hole ──
{
  const exit = await new Promise((resolve) => {
    const s3 = spawn('node', ['dist/server.js'], {
      env: { ...process.env, PORT: '3950', SHOTBASE_TEST_GATE_OCCUPY: '1', NODE_ENV: 'production', REDIS_URL: '', SUPABASE_URL: '' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const t = setTimeout(() => { try { s3.kill('SIGKILL') } catch {}; resolve(null) }, 8000)
    s3.on('exit', (code) => { clearTimeout(t); resolve(code) })
  })
  assert(exit !== 0 && exit !== null, `lever + NODE_ENV=production → process refuses to boot (exit code ${exit})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
