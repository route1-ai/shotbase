// AI-quota graceful degradation — REAL 200 body + headers + the counted row.
// quota.mjs proves the *gating* via the SSRF-localhost trick; this proves the actual
// served response. Spawns the backend against a mock Supabase pinned at AI usage = 25
// (exhausted) / capture usage = 5, with INVALID (but present) AWS creds so bedrockClient
// initializes and the request reaches the quota check (Bedrock is never called — it's
// skipped). Real captures of https://example.com (network + local Playwright browser).
//
// Uses a static API key (no SB_KEY needed); owner = 'static-key', plan = free.

import http from 'node:http'
import { spawn } from 'node:child_process'

const KEY = 'degradekey'
const CAP_USED = 5, AI_USED = 25, CAP_LIMIT = 250, AI_LIMIT = 25 // free plan
const PORT = 3993
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Mock Supabase: fixed counts + capture inserted rows ───────────────────────
const rows = []
const mock = http.createServer((req, res) => {
  const u = req.url || ''
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    if (u.includes('/rest/v1/screenshots') && (req.method === 'GET' || req.method === 'HEAD')) {
      const ai = u.includes('ai_succeeded=eq.true')
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': `*/${ai ? AI_USED : CAP_USED}` }); return res.end('')
    }
    if (u.includes('/rest/v1/screenshots') && req.method === 'POST') {
      try { const p = JSON.parse(b); for (const r of Array.isArray(p) ? p : [p]) rows.push(r) } catch {}
      res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]')
    }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const mockPort = mock.address().port

const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), API_KEYS: KEY, UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`, SUPABASE_SERVICE_ROLE_KEY: 'test', REDIS_URL: '',
    AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'AKIAINVALIDTESTKEY000', AWS_SECRET_ACCESS_KEY: 'invalidsecret0000000000000000000000000000',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

const B = `http://localhost:${PORT}`
const uniq = () => 'https://example.com/?cb=' + Date.now() + '_' + Math.random().toString(36).slice(2)
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
async function post(body) {
  const url = body.url
  const r = await fetch(`${B}/screenshot`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const ct = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  return {
    status: r.status, ct, bytes: buf.length,
    json: ct.includes('application/json') ? JSON.parse(buf.toString()) : null,
    h: (n) => r.headers.get(n), url,
  }
}
async function rowFor(url, ms = 6000) {
  const t = Date.now()
  while (Date.now() - t < ms) { const m = rows.find((r) => r.url === url); if (m) return m; await sleep(150) }
  return null
}
async function up() { for (let i = 0; i < 40; i++) { try { const h = await fetch(`${B}/health`); if (h.ok) return true } catch {} await sleep(500) } return false }
if (!(await up())) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // A) REST include_text + ai_extract, AI exhausted, capture OK → 200 degrade ──
  {
    const url = uniq()
    const r = await post({ url, include_text: true, ai_extract: { page_type: true, headings: true, ctas: true, prices: true } })
    assert(r.status === 200 && r.ct.includes('application/json'), `degrade → HTTP 200 JSON (got ${r.status} ${r.ct})`)
    assert(typeof r.json?.text === 'string' && r.json.text.length > 0, `text served (len=${r.json?.text?.length})`)
    assert(r.json?.ai_data === null, `ai_data === null (got ${JSON.stringify(r.json?.ai_data)})`)
    assert(r.json?.ai_skipped === 'monthly_quota_exceeded', `ai_skipped === "monthly_quota_exceeded" (got ${JSON.stringify(r.json?.ai_skipped)})`)
    assert(r.json?.ai_error === undefined, `ai_error absent on skip (got ${JSON.stringify(r.json?.ai_error)})`)
    assert(r.h('x-shotbase-ai-remaining') === '0', `X-Shotbase-AI-Remaining: 0 (got ${r.h('x-shotbase-ai-remaining')})`)
    assert(r.h('x-shotbase-captures-remaining') === String(CAP_LIMIT - CAP_USED), `X-Shotbase-Captures-Remaining: ${CAP_LIMIT - CAP_USED} (got ${r.h('x-shotbase-captures-remaining')})`)
    assert(/^\d{9,}$/.test(r.h('x-shotbase-quota-reset') || ''), `X-Shotbase-Quota-Reset is a unix epoch (got ${r.h('x-shotbase-quota-reset')})`)
    assert(r.h('x-shotbase-ai-skipped') === null, `no X-Shotbase-AI-Skipped header on REST JSON (field is used instead)`)
    const row = await rowFor(url)
    assert(row && row.status === 200 && row.ai_requested === true && row.ai_succeeded === false,
      `capture COUNTED: one row status200 ai_requested=true ai_succeeded=false (${row ? JSON.stringify({ s: row.status, req: row.ai_requested, suc: row.ai_succeeded }) : 'no row'})`)
  }

  // B) REST ai_extract ONLY (no text), AI exhausted → hard 429, no row ─────────
  {
    const url = uniq()
    const before = rows.length
    const r = await post({ url, ai_extract: { page_type: true } })
    await sleep(600)
    assert(r.status === 429 && r.json?.error === 'Monthly AI extraction quota exceeded' && r.json?.quota_type === 'ai_extractions'
      && r.json?.limit === AI_LIMIT && r.json?.used === AI_USED, `ai_extract-only → hard 429 verbatim (${JSON.stringify(r.json)})`)
    assert(!rows.some((x) => x.url === url) && rows.length === before, `AI-only 429 wrote NO row (capture not counted)`)
  }

  // C) REST plain capture (no AI) → 200 binary; capture headers, NO AI-Remaining ─
  {
    const url = uniq()
    const r = await post({ url })
    assert(r.status === 200 && r.ct.startsWith('image/') && r.bytes > 1000, `plain → 200 image (${r.ct}, ${r.bytes}b)`)
    assert(r.h('x-shotbase-captures-remaining') === String(CAP_LIMIT - CAP_USED), `plain: X-Shotbase-Captures-Remaining present (${r.h('x-shotbase-captures-remaining')})`)
    assert(r.h('x-shotbase-ai-remaining') === null, `plain: NO X-Shotbase-AI-Remaining (AI usage not read → no extra round trip)`)
    assert(/^\d{9,}$/.test(r.h('x-shotbase-quota-reset') || ''), `plain: X-Shotbase-Quota-Reset present`)
  }

  // D) MCP extract=true, AI exhausted → image + skip marker + header + counted row ─
  {
    const url = uniq()
    const r = await fetch(`${B}/api/mcp`, { method: 'POST', headers: H, signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url, extract: true } } }) })
    const aiSkipHdr = r.headers.get('x-shotbase-ai-skipped')
    const aiRemHdr = r.headers.get('x-shotbase-ai-remaining')
    const j = await r.json()
    const content = j?.result?.content ?? []
    const hasImage = content.some((x) => x.type === 'image')
    const marker = content.filter((x) => x.type === 'text').map((x) => x.text).join(' ')
    assert(j?.result?.isError === false && hasImage, `MCP degrade → image returned, isError:false (image=${hasImage})`)
    assert(/ai_skipped: monthly_quota_exceeded/.test(marker) && !j?.result?.structuredContent, `MCP degrade → ai_skipped marker, no structuredContent ("${marker.slice(0, 40)}")`)
    assert(aiSkipHdr === 'monthly_quota_exceeded' && aiRemHdr === '0', `MCP headers: X-Shotbase-AI-Skipped + AI-Remaining:0 (skip=${aiSkipHdr}, rem=${aiRemHdr})`)
    const row = await rowFor(url)
    assert(row && row.status === 200 && row.ai_requested === true && row.ai_succeeded === false, `MCP degrade capture COUNTED (ai_succeeded=false)`)
  }
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
