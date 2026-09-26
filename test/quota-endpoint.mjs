// GET /quota — read remaining budget WITHOUT spending a capture.
// Mock Supabase returns capture usage = 5 / AI usage = 25 (free-plan caps 250/25),
// and records any POST insert so we can prove /quota never writes a screenshots row.
// The mock runs in this process, so `failMode` toggles the accounting-failure case.
// No browser / no network — /quota performs no capture.

import http from 'node:http'
import { spawn } from 'node:child_process'

const KEY = 'quotakey'
const CAP_USED = 5, AI_USED = 25, CAP_LIMIT = 250, AI_LIMIT = 25 // free plan
const PORT = 3994
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failMode = false // when true the mock 500s on count queries → accounting failure
const rows = []
const mock = http.createServer((req, res) => {
  const u = req.url || ''
  let b = ''
  req.on('data', (c) => (b += c))
  req.on('end', () => {
    if (u.includes('/rest/v1/screenshots') && (req.method === 'GET' || req.method === 'HEAD')) {
      if (failMode) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"message":"boom"}') }
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
    AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)

const B = `http://localhost:${PORT}`
async function quota(key) {
  const r = await fetch(`${B}/quota`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10000) })
  let body = null; try { body = await r.json() } catch {}
  return { status: r.status, body, h: (n) => r.headers.get(n) }
}
async function up() { for (let i = 0; i < 40; i++) { try { const h = await fetch(`${B}/health`); if (h.ok) return true } catch {} await sleep(300) } return false }
if (!(await up())) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // 1) No auth → 401 ───────────────────────────────────────────────────────────
  {
    const r = await quota(null)
    assert(r.status === 401 && r.body?.error === 'Missing Authorization header', `no auth → 401 (${r.status})`)
  }

  // 2) Bad key → 401 ────────────────────────────────────────────────────────────
  {
    const r = await quota('not-a-real-key')
    assert(r.status === 401 && /Invalid API key/.test(r.body?.error || ''), `bad key → 401 (${r.status})`)
  }

  // 3) Valid key → 200 snapshot; NO capture spent ──────────────────────────────
  {
    const before = rows.length
    const r = await quota(KEY)
    assert(r.status === 200, `valid → 200 (${r.status})`)
    assert(r.body?.plan === 'free', `plan: free (${r.body?.plan})`)
    assert(r.body?.captures?.used === CAP_USED && r.body?.captures?.limit === CAP_LIMIT && r.body?.captures?.remaining === CAP_LIMIT - CAP_USED,
      `captures {used:${CAP_USED}, limit:${CAP_LIMIT}, remaining:${CAP_LIMIT - CAP_USED}} (${JSON.stringify(r.body?.captures)})`)
    assert(r.body?.ai_extractions?.used === AI_USED && r.body?.ai_extractions?.limit === AI_LIMIT && r.body?.ai_extractions?.remaining === 0,
      `ai_extractions {used:${AI_USED}, limit:${AI_LIMIT}, remaining:0} (${JSON.stringify(r.body?.ai_extractions)})`)
    assert(Number.isInteger(r.body?.reset) && r.body.reset > 1_700_000_000, `reset is a unix epoch (${r.body?.reset})`)
    assert(r.h('x-shotbase-captures-remaining') === String(CAP_LIMIT - CAP_USED), `header Captures-Remaining (${r.h('x-shotbase-captures-remaining')})`)
    assert(r.h('x-shotbase-ai-remaining') === '0', `header AI-Remaining: 0 (${r.h('x-shotbase-ai-remaining')})`)
    assert(/^\d{9,}$/.test(r.h('x-shotbase-quota-reset') || ''), `header Quota-Reset (${r.h('x-shotbase-quota-reset')})`)
    await sleep(400)
    assert(rows.length === before, `NO capture spent: zero screenshots rows written (delta=${rows.length - before})`)
  }

  // 4) Accounting failure → 503 (fail closed, no fabricated numbers) ────────────
  {
    failMode = true
    const r = await quota(KEY)
    failMode = false
    assert(r.status === 503 && r.body?.error === 'Usage temporarily unavailable', `count query fails → 503 (${r.status} ${JSON.stringify(r.body)})`)
  }
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
