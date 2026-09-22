// REST graceful extraction-degradation (Option B) + provider-error leak-safety.
// Self-contained: spawns the backend as a child process.
//
// Cases:
//   1. render OK + extraction OK   → 200, ai_data populated, no ai_error
//        (requires a working Bedrock account; SKIPS cleanly if account-gated)
//   2. render OK + extraction FAIL → 200, render/text preserved, ai_data:null,
//        generic ai_error, NO provider internals leaked
//   3. browser/render FAIL         → non-2xx (NOT the graceful 200 shape)
//   4. MCP unchanged               → image kept + generic marker on extract fail;
//        render fail is an MCP isError
//
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value). For case 1 to actually run,
// invoke with real AWS_* creds in env; otherwise case 1 SKIPS.

import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
const GOOD_URL = 'https://example.com'
// Public host that passes the SSRF guard but fails inside the browser (expired cert)
// → a genuine render/capture failure, distinct from an SSRF rejection.
const BAD_RENDER_URL = 'https://expired.badssl.com/'
const GENERIC = 'AI extraction temporarily unavailable'
const FORBIDDEN = ['account', 'use case', 'submitted', 'arn:', 'security token',
  'accessdenied', 'resourcenotfound', 'credential', 'anthropic.claude', 'inference profile', 'bedrock', 'iam ']

let pass = 0, fail = 0, skip = 0
const ok   = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad  = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const skp  = (m) => { skip++; console.log(`  SKIP  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const leaks = (s) => { const low = String(s ?? '').toLowerCase(); return FORBIDDEN.filter((f) => low.includes(f)) }
const post = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${BYPASS}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_degrade' },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(45000),
})

async function withServer(env, fn) {
  const child = spawn('node', ['dist/server.js'], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit'] })
  const port = env.PORT
  try {
    let up = false
    for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${port}/health`)).ok) { up = true; break } } catch {} await sleep(500) }
    if (!up) { bad(`server failed to start on ${port}`); return }
    await fn(`http://localhost:${port}`)
  } finally { try { child.kill('SIGKILL') } catch {} await sleep(300) }
}

const INVALID_AWS = { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAINVALIDTESTKEY000', AWS_SECRET_ACCESS_KEY: 'invalidsecret0000000000000000000000000000' }
const BASE_ENV = { PLAYGROUND_BYPASS_KEY: BYPASS, UNKEY_ROOT_KEY: '' }

// ── Case 1: extraction success (real creds; skips if gated) ──────────────────
console.log('— Case 1: render OK + extraction OK —')
const haveRealAws = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && !process.env.AWS_ACCESS_KEY_ID.startsWith('AKIAINVALID'))
if (!haveRealAws) {
  skp('no real AWS creds in env → case 1 not run (pass real AWS_* to exercise)')
} else {
  await withServer({ ...BASE_ENV, PORT: '3951', AWS_REGION: process.env.AWS_REGION ?? 'us-east-1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY }, async (B) => {
    const r = await post(B, '/screenshot', { url: GOOD_URL, include_text: true, ai_extract: { page_type: true, headings: true, ctas: true, prices: true } })
    const b = await r.json()
    if (r.status === 200 && b.ai_data && typeof b.ai_data === 'object' && !b.ai_error) {
      ok(`extraction succeeded → ai_data populated (${JSON.stringify(Object.keys(b.ai_data))}), no ai_error`)
    } else if (r.status === 200 && b.ai_error === GENERIC && b.ai_data === null) {
      skp('Bedrock account-gated → case 1 skipped (auto-passes once model access granted)')
    } else {
      bad(`unexpected case-1 response: status=${r.status} ai_data=${JSON.stringify(b.ai_data)} ai_error=${JSON.stringify(b.ai_error)}`)
    }
  })
}

// ── Cases 2–4: invalid AWS creds → deterministic extraction failure ──────────
await withServer({ ...BASE_ENV, ...INVALID_AWS, PORT: '3952' }, async (B) => {
  // Bedrock client is initialized from the (invalid) AWS creds; /health no longer
  // exposes a bedrock flag (it must never call Bedrock), so we verify the failure
  // behavior directly via the responses below rather than a health precondition.
  const h = await (await fetch(`${B}/health`)).json()
  assert(h.status === 'ok', `server healthy for failure-path cases (status=${h.status})`)

  console.log('— Case 2: render OK + extraction FAIL → graceful 200 —')
  const r2 = await post(B, '/screenshot', { url: GOOD_URL, include_text: true, ai_extract: { page_type: true, headings: true, ctas: true, prices: true } })
  const b2 = await r2.json()
  assert(r2.status === 200, `HTTP 200 (got ${r2.status})`)
  assert(b2.ai_data === null, `ai_data === null (got ${JSON.stringify(b2.ai_data)})`)
  assert(b2.ai_error === GENERIC, `ai_error is generic (got ${JSON.stringify(b2.ai_error)})`)
  assert(typeof b2.text === 'string' && b2.text.length > 0, `page text preserved (len=${b2.text?.length})`)
  assert(typeof b2.render_time_ms === 'number', `render metadata preserved (render_time_ms=${b2.render_time_ms})`)
  assert(b2.error === undefined && b2.detail === undefined, `no top-level error/detail field`)
  const l2 = leaks(b2.ai_error)
  assert(l2.length === 0, `no provider internals in ai_error${l2.length ? ' — LEAKED: ' + l2.join(',') : ''}`)

  console.log('— Case 3: browser/render FAIL → non-2xx (not graceful) —')
  const r3 = await post(B, '/screenshot', { url: BAD_RENDER_URL, ai_extract: { page_type: true } })
  const b3 = await r3.json().catch(() => ({}))
  assert(r3.status !== 200, `render failure is non-2xx (got ${r3.status})`)
  assert(b3.ai_error === undefined && !('ai_data' in b3), `render failure does NOT use the graceful ai_error/ai_data shape`)

  console.log('— Case 4: MCP unchanged —')
  const m1 = await (await post(B, '/api/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: GOOD_URL, extract: true } } })).json()
  const c1 = m1?.result?.content ?? []
  const img = c1.some((x) => x.type === 'image')
  const marker = c1.filter((x) => x.type === 'text').map((x) => x.text)
  assert(img && m1?.result?.isError === false, `MCP extract-fail keeps image + isError:false (image=${img})`)
  assert(marker.some((t) => t.includes(GENERIC)), `MCP degrades with generic marker (got ${JSON.stringify(marker)})`)
  assert(leaks(marker.join(' ')).length === 0, `MCP marker leaks no provider internals`)

  const m2 = await (await post(B, '/api/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: BAD_RENDER_URL, extract: false } } })).json()
  assert(m2?.result?.isError === true, `MCP render failure is isError:true (unchanged)`)
})

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`)
process.exit(fail === 0 ? 0 : 1)
