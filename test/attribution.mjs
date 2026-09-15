// Playground user-attribution tests (P0). Two layers:
//  A) Unit: resolveOwner() logic (imported from the built server).
//  B) E2E: spin a mock Supabase that captures inserted rows, spawn the real backend
//     pointed at it, and prove the resolved userId flows into usage logging —
//     and that spoofing / missing attribution is handled correctly.
//
// Requires: SB_KEY (the real PLAYGROUND_BYPASS_KEY) in env. Uses https://example.com
// for real captures (needs network + the local Playwright browser).

import http from 'node:http'
import { spawn } from 'node:child_process'
import { resolveOwner, isValidUserId } from '../dist/server.js'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY (the PLAYGROUND_BYPASS_KEY value) is required.'); process.exit(2) }
const STATIC_KEY = 'teststatickey'
const URL_ = process.env.SB_URL ?? 'https://example.com'

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ─── A) Unit: resolveOwner ──────────────────────────────────────────────────
console.log('── resolveOwner (unit) ──')
{
  const r = resolveOwner({ valid: true, plan: 'pro', viaBypass: true }, 'user_2abcDEF')
  assert(r.ok && r.ownerId === 'user_2abcDEF', 'bypass + valid header → attributes to that user id')
}
{
  const r = resolveOwner({ valid: true, plan: 'pro', viaBypass: true }, undefined)
  assert(!r.ok, 'bypass + missing header → rejected (fail closed)')
}
{
  const r = resolveOwner({ valid: true, plan: 'pro', viaBypass: true }, '   ')
  assert(!r.ok, 'bypass + blank header → rejected')
}
{
  const r = resolveOwner({ valid: true, plan: 'pro', viaBypass: true }, 'bad id/../x')
  assert(!r.ok, 'bypass + malformed header (bad chars) → rejected')
}
{
  const r = resolveOwner({ valid: true, plan: 'free', ownerId: 'static-key' }, 'user_spoof')
  assert(r.ok && r.ownerId === 'static-key', 'non-bypass key + spoofed header → header ignored (uses key owner)')
}
{
  const r = resolveOwner({ valid: true, plan: 'pro', ownerId: 'user_real', viaBypass: false }, 'user_spoof')
  assert(r.ok && r.ownerId === 'user_real', 'unkey owner + spoofed header → header ignored')
}
assert(isValidUserId('user_2aBc-1') && !isValidUserId('a b') && !isValidUserId('') && !isValidUserId('x'.repeat(256)),
  'isValidUserId charset/length bounds')

// ─── B) E2E: mock Supabase + real backend ───────────────────────────────────
console.log('\n── attribution end-to-end (mock Supabase captures user_id) ──')
const rows = [] // captured { user_id, url, status } from logScreenshot inserts
const mock = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.includes('/rest/v1/screenshots')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      // supabase-js sends a single object for insert(obj), or an array for insert([...]).
      try { const p = JSON.parse(body); for (const row of Array.isArray(p) ? p : [p]) rows.push(row) } catch {}
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('[]')
    })
  } else { res.writeHead(200); res.end('ok') }
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

const PORT = 3941
const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PLAYGROUND_BYPASS_KEY: BYPASS,
    API_KEYS: STATIC_KEY,
    // point usage logging at the mock; do NOT set UNKEY_ROOT_KEY (static fallback + bypass path)
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role',
    UNKEY_ROOT_KEY: '',
    MAX_BROWSER_CONCURRENCY: '2',
    MAX_BROWSER_QUEUE: '5',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})

function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

async function health() { try { const r = await fetch(`http://localhost:${PORT}/health`); return r.ok } catch { return false } }
let up = false
for (let i = 0; i < 30; i++) { if (await health()) { up = true; break } await sleep(500) }
if (!up) { bad('backend failed to start'); cleanup(); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

const B = `http://localhost:${PORT}`
const hdr = (key, uid, i) => {
  const h = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  if (uid !== null) h['X-Shotbase-User-Id'] = uid
  return h
}
async function shot(key, uid, i) {
  const res = await fetch(`${B}/screenshot`, { method: 'POST', headers: hdr(key, uid), body: JSON.stringify({ url: URL_, width: 700 + i, height: 500 }) })
  return { status: res.status }
}
async function mcp(key, uid, i) {
  const h = hdr(key, uid);
  const res = await fetch(`${B}/api/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: URL_, extract: false, viewport: { width: 700 + i, height: 500 } } } }) })
  return res.json()
}
async function waitForRow(pred, ms = 6000) {
  const t = Date.now()
  while (Date.now() - t < ms) { if (rows.some(pred)) return true; await sleep(150) }
  return false
}

try {
  // 1) bypass + valid user id → attributed to that user
  const s1 = await shot(BYPASS, 'user_realuser', 1)
  const seen1 = await waitForRow((r) => r.user_id === 'user_realuser')
  assert(s1.status === 200 && seen1, `bypass + valid user id → 200 and usage row user_id="user_realuser" (status=${s1.status}, logged=${seen1})`)

  // 2) bypass without user id → rejected, no capture logged
  const before2 = rows.length
  const s2 = await shot(BYPASS, null, 2)
  await sleep(800)
  assert(s2.status === 401 && rows.length === before2, `bypass without user id → 401 and nothing logged (status=${s2.status}, newRows=${rows.length - before2})`)

  // 3) ordinary static API key + spoofed header → spoof ignored, logged as key owner
  const s3 = await shot(STATIC_KEY, 'user_victim', 3)
  const seenOwner = await waitForRow((r) => r.user_id === 'static-key')
  const spoofLeaked = rows.some((r) => r.user_id === 'user_victim')
  assert(s3.status === 200 && seenOwner && !spoofLeaked, `static key + spoofed header → logged as "static-key", spoof ignored (status=${s3.status}, owner=${seenOwner}, leaked=${spoofLeaked})`)

  // 4) bad bypass secret → rejected
  const s4 = await shot('not-the-real-secret', 'user_x', 4)
  assert(s4.status === 401, `bad bypass secret → 401 (status=${s4.status})`)

  // 5) MCP with real (static) API key + spoofed header → works, spoof ignored
  const m5 = await mcp(STATIC_KEY, 'user_victim2', 5)
  const m5img = !!m5?.result?.content?.some((b) => b.type === 'image')
  const seen5 = await waitForRow((r) => r.user_id === 'static-key' && String(r.url).includes('example'))
  const spoof5 = rows.some((r) => r.user_id === 'user_victim2')
  assert(m5img && !spoof5, `MCP real API key unchanged → image returned, spoof ignored (image=${m5img}, leaked=${spoof5})`)

  // 6) MCP bypass without user id → unauthorized (-32001), fail closed
  const m6 = await mcp(BYPASS, null, 6)
  assert(m6?.error?.code === -32001, `MCP bypass without user id → -32001 unauthorized (got ${JSON.stringify(m6?.error ?? m6?.result)?.slice(0, 80)})`)
} finally {
  cleanup()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
