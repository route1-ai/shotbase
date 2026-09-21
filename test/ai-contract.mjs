// REST AI/text extraction contract (Playground-facing) — response shape + the exact
// usage-accounting row per mode. Self-contained: spawns the real backend with INVALID
// (but present) AWS creds so bedrockClient initializes and Bedrock fails
// deterministically, pointed at a mock Supabase that captures inserted rows.
//
// Proves per mode: response type (binary vs JSON), text/ai_data presence, generic +
// leak-safe ai_error, exactly ONE capture row, and its ai_requested/ai_succeeded/
// status fields. Real-Bedrock SUCCESS (ai_succeeded=true) is exercised only when real
// AWS_* creds are supplied (otherwise skipped, like extraction-degrade case 1).
//
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value). Uses https://example.com (network +
// local Playwright browser).

import http from 'node:http'
import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
const URL_ = process.env.SB_URL ?? 'https://example.com'
const GENERIC = 'AI extraction temporarily unavailable'
const FORBIDDEN = ['account', 'use case', 'submitted', 'arn:', 'security token', 'accessdenied',
  'resourcenotfound', 'credential', 'anthropic.claude', 'inference profile', 'bedrock', 'iam ']

let pass = 0, fail = 0, skip = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const skp = (m) => { skip++; console.log(`  SKIP  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const leaks = (s) => { const low = String(s ?? '').toLowerCase(); return FORBIDDEN.filter((f) => low.includes(f)) }

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

const haveRealAws = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY && !process.env.AWS_ACCESS_KEY_ID.startsWith('AKIAINVALID'))
const AWS = haveRealAws
  ? { AWS_REGION: process.env.AWS_REGION ?? 'us-east-1', AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY }
  : { AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAINVALIDTESTKEY000', AWS_SECRET_ACCESS_KEY: 'invalidsecret0000000000000000000000000000' }

const PORT = 3981
const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env, ...AWS, PORT: String(PORT), PLAYGROUND_BYPASS_KEY: BYPASS, UNKEY_ROOT_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test-service',
    MAX_BROWSER_CONCURRENCY: '2', MAX_BROWSER_QUEUE: '5',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

async function req(uid, extra) {
  const r = await fetch(`http://localhost:${PORT}/screenshot`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BYPASS}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': uid },
    body: JSON.stringify({ url: URL_, ...extra }),
    signal: AbortSignal.timeout(60000),
  })
  const ct = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  const json = ct.includes('application/json') ? JSON.parse(buf.toString()) : null
  return { status: r.status, ct, bytes: buf.length, json }
}
async function rowFor(uid, ms = 6000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const m = rows.filter((r) => r.user_id === uid); if (m.length) return m; await sleep(150) }
  return []
}

async function up() { for (let i = 0; i < 40; i++) { try { const h = await fetch(`http://localhost:${PORT}/health`); if (h.ok && (await h.json()).supabase === true) return true } catch {} await sleep(500) } return false }
if (!(await up())) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // A) plain screenshot → binary, one capture, zero AI
  {
    const r = await req('u_plain', {})
    const rw = await rowFor('u_plain')
    assert(r.status === 200 && r.ct.startsWith('image/') && r.json === null && r.bytes > 1000, `A plain → binary image (ct=${r.ct}, bytes=${r.bytes})`)
    assert(rw.length === 1 && rw[0].status === 200 && rw[0].ai_requested === false && rw[0].ai_succeeded === false,
      `A plain → ONE row status200 ai_requested=false ai_succeeded=false (rows=${rw.length}, ${JSON.stringify(rw[0] && { s: rw[0].status, req: rw[0].ai_requested, suc: rw[0].ai_succeeded })})`)
  }

  // B) include_text=true → JSON, text present, one capture, zero AI
  {
    const r = await req('u_text', { include_text: true })
    const rw = await rowFor('u_text')
    assert(r.status === 200 && r.ct.includes('application/json') && typeof r.json?.text === 'string' && r.json.text.length > 0 && r.json.ai_data === undefined,
      `B include_text → JSON with text, no ai_data (textLen=${r.json?.text?.length})`)
    assert(rw.length === 1 && rw[0].status === 200 && rw[0].ai_requested === false && rw[0].ai_succeeded === false,
      `B include_text → ONE row ai_requested=false ai_succeeded=false`)
  }

  // E) ai_extract={} → no AI invocation, binary image, row ai_requested=false
  {
    const r = await req('u_empty', { ai_extract: {} })
    const rw = await rowFor('u_empty')
    assert(r.status === 200 && r.ct.startsWith('image/'), `E ai_extract={} → binary image (not JSON) (ct=${r.ct})`)
    assert(rw.length === 1 && rw[0].ai_requested === false && rw[0].ai_succeeded === false, `E ai_extract={} → row ai_requested=false (no AI)`)
  }

  // F) ai_extract all-false → no AI invocation
  {
    const r = await req('u_false', { ai_extract: { page_type: false, headings: false, ctas: false, prices: false } })
    const rw = await rowFor('u_false')
    assert(r.status === 200 && r.ct.startsWith('image/'), `F ai_extract all-false → binary image (not JSON)`)
    assert(rw.length === 1 && rw[0].ai_requested === false && rw[0].ai_succeeded === false, `F ai_extract all-false → row ai_requested=false (no AI)`)
  }

  // G) ai_extract 4 fields, Bedrock FAILS (invalid creds) → graceful 200, ai_data null,
  //    generic + leak-safe ai_error, row ai_requested=true ai_succeeded=false (AI NOT counted).
  //    C) upgrades to a success assertion when real AWS creds are present.
  {
    const r = await req('u_ai', { ai_extract: { page_type: true, headings: true, ctas: true, prices: true } })
    const rw = await rowFor('u_ai')
    assert(r.status === 200 && r.ct.includes('application/json'), `${haveRealAws ? 'C' : 'G'} ai_extract → JSON 200 (ct=${r.ct})`)
    if (haveRealAws && r.json?.ai_data && !r.json.ai_error) {
      ok(`C real Bedrock success → ai_data populated (${JSON.stringify(Object.keys(r.json.ai_data))}), no ai_error`)
      assert(rw.length === 1 && rw[0].ai_requested === true && rw[0].ai_succeeded === true, `C success → row ai_requested=true ai_succeeded=true (AI counts)`)
    } else {
      assert(r.json?.ai_data === null && r.json?.ai_error === GENERIC, `G Bedrock fail → ai_data null + generic ai_error (ai_error=${JSON.stringify(r.json?.ai_error)})`)
      assert(leaks(r.json?.ai_error).length === 0, `G ai_error leaks no provider internals`)
      assert(rw.length === 1 && rw[0].status === 200 && rw[0].ai_requested === true && rw[0].ai_succeeded === false,
        `G Bedrock fail → row status200 ai_requested=true ai_succeeded=false (AI NOT counted)`)
    }
  }

  // D) include_text + ai_extract → JSON has BOTH text and ai_data key (null on fail)
  {
    const r = await req('u_both', { include_text: true, ai_extract: { page_type: true } })
    assert(r.status === 200 && r.ct.includes('application/json') && typeof r.json?.text === 'string' && r.json.text.length > 0 && ('ai_data' in r.json),
      `D text+AI → JSON has text AND ai_data key (textLen=${r.json?.text?.length}, ai_data=${JSON.stringify(r.json?.ai_data)})`)
    const rw = await rowFor('u_both')
    assert(rw.length === 1 && rw[0].ai_requested === true, `D text+AI → row ai_requested=true`)
  }
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`)
process.exit(fail === 0 ? 0 : 1)
