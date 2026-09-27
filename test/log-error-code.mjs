// logScreenshot persists error_code + a clean error_message on failed captures (NULL on
// success), so the dashboard Activity log can show why a capture failed. Uses a mock
// Supabase that records inserted rows. A failed capture is triggered deterministically
// with a reserved, non-routable IP (198.51.100.1) + a low NAV_TIMEOUT — no live site.

import http from 'node:http'
import { spawn } from 'node:child_process'

const KEY = 'logerrkey'
const PORT = 3982
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = []
const mock = http.createServer((req, res) => {
  const u = req.url || ''; let b = ''
  req.on('data', (c) => (b += c)); req.on('end', () => {
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
    AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', NAV_TIMEOUT_MS: '3000' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} try { mock.close() } catch {} }
process.on('exit', cleanup)
const B = `http://localhost:${PORT}`
const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
async function shot(url) {
  const r = await fetch(`${B}/screenshot`, { method: 'POST', headers: H, body: JSON.stringify({ url }), signal: AbortSignal.timeout(40000) })
  return { status: r.status }
}
async function rowFor(url, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const m = rows.find((r) => r.url === url); if (m) return m; await sleep(150) } return null }
async function up() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`${B}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up())) { bad('server failed to start') }
else {
  // Failed capture (reserved non-routable IP + low timeout) → logged row carries the code + clean message.
  {
    const url = `http://198.51.100.1/?id=${Date.now()}`
    const r = await shot(url)
    assert(r.status >= 500, `failed capture returns 5xx (${r.status})`)
    const row = await rowFor(url)
    const CODES = ['navigation_timeout', 'connection_refused', 'ssl_error', 'render_failed']
    assert(row != null, 'a screenshots row was logged for the failure')
    assert(row && CODES.includes(row.error_code), `row.error_code is a capture code (${row?.error_code})`)
    assert(row && typeof row.error_message === 'string' && row.error_message.includes('198.51.100.1'), `row.error_message is a clean message incl. host (${row?.error_message})`)
    assert(row && !/Call log|node:internal|\.ts:|\/Users\//.test(row.error_message || ''), 'error_message has no raw Playwright output / stack / path')
    assert(row && row.status >= 500, `row.status reflects the mapped failure status (${row?.status})`)
  }
  // Successful capture → error_code / error_message are NULL.
  {
    const url = `https://example.com/?id=${Date.now()}`
    const r = await shot(url)
    assert(r.status === 200, `success → 200 (${r.status})`)
    const row = await rowFor(url)
    assert(row && row.status === 200 && (row.error_code === null || row.error_code === undefined), `success row: error_code NULL (${row?.error_code})`)
    assert(row && (row.error_message === null || row.error_message === undefined), `success row: error_message NULL (${row?.error_message})`)
  }
}
cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
