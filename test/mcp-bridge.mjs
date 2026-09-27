// @shotbase/mcp stdio bridge: forwards JSON-RPC verbatim to the hosted /api/mcp.
// Driven against a LOCAL backend (static key + mock Supabase) so it's deterministic and
// offline. Proves: missing key → hard exit; initialize/tools/list/tools/call forward
// correctly; tools/list schema comes from the live server (not hardcoded); a notification
// produces no response.

import http from 'node:http'
import readline from 'node:readline'
import { spawn } from 'node:child_process'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 1) missing key → non-zero exit, nothing on stdout ──────────────────────────
{
  const code = await new Promise((resolve) => {
    const c = spawn('node', ['packages/mcp/index.mjs'], { env: { ...process.env, SHOTBASE_API_KEY: '' }, stdio: ['ignore', 'ignore', 'ignore'] })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch {}; resolve('timeout') }, 5000)
    c.on('exit', (x) => { clearTimeout(t); resolve(x) })
  })
  assert(code === 1, `missing API key → exit 1 (${code})`)
}

// ── Local backend the bridge will forward to ───────────────────────────────────
const KEY = 'bridgekey'
const PORT = 3983
const mock = http.createServer((req, res) => {
  const u = req.url || ''; let b = ''
  req.on('data', (c) => (b += c)); req.on('end', () => {
    if (u.includes('/rest/v1/screenshots') && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'content-range': '*/0' }); return res.end('')
    }
    if (u.includes('/rest/v1/screenshots') && req.method === 'POST') { res.writeHead(201, { 'Content-Type': 'application/json' }); return res.end('[]') }
    res.writeHead(200); res.end('ok')
  })
})
await new Promise((r) => mock.listen(0, '127.0.0.1', r))
const backend = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), API_KEYS: KEY, UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '',
    SUPABASE_URL: `http://127.0.0.1:${mock.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'test', REDIS_URL: '', AWS_REGION: '', AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
let bridge
function cleanup() { for (const c of [backend, bridge]) { try { c?.kill('SIGKILL') } catch {} } try { mock.close() } catch {} }
process.on('exit', cleanup)
async function up() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return true } catch {} await sleep(300) } return false }

if (!(await up())) { bad('backend failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

// ── 2) drive the bridge over stdio ─────────────────────────────────────────────
bridge = spawn('node', ['packages/mcp/index.mjs'], {
  env: { ...process.env, SHOTBASE_API_KEY: KEY, SHOTBASE_MCP_URL: `http://localhost:${PORT}/api/mcp` },
  stdio: ['pipe', 'pipe', 'ignore'],
})
const responses = []
readline.createInterface({ input: bridge.stdout }).on('line', (l) => { const t = l.trim(); if (!t) return; try { responses.push(JSON.parse(t)) } catch {} })
const write = (obj) => bridge.stdin.write(JSON.stringify(obj) + '\n')

write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
write({ jsonrpc: '2.0', method: 'notifications/initialized' }) // notification → no response expected
write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: `http://nope-${Date.now()}.invalid/`, extract: false } } })
await sleep(3500)

const byId = (n) => responses.find((r) => r.id === n)
assert(byId(1)?.result?.serverInfo?.name === 'shotbase', `initialize forwarded → serverInfo.name=shotbase (${byId(1)?.result?.serverInfo?.name})`)
assert(byId(2)?.result?.tools?.[0]?.name === 'shotbase_capture', `tools/list forwarded from live server → shotbase_capture (${byId(2)?.result?.tools?.[0]?.name})`)
assert(Array.isArray(byId(2)?.result?.tools?.[0]?.inputSchema?.required) && byId(2).result.tools[0].inputSchema.required.includes('url'), 'tools/list schema is the live schema (url required) — not hardcoded in the package')
assert(byId(3)?.result?.isError === true, `tools/call for a bad domain forwarded → isError:true (${byId(3)?.result?.isError})`)
assert(responses.filter((r) => r.id === undefined || r.id === null).length === 0, 'the notification produced NO response line')
assert(responses.length === 3, `exactly 3 responses for 3 requests + 1 notification (got ${responses.length})`)

cleanup()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
