// Body-size protection (Phase B) for POST /screenshot and POST /api/mcp.
// Self-contained: spawns the backend with a small MAX_BODY_BYTES so oversize is easy.
// Requires SB_KEY (PLAYGROUND_BYPASS_KEY value).

import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY required'); process.exit(2) }
const PORT = 3961
const LIMIT = 2048

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), PLAYGROUND_BYPASS_KEY: BYPASS, MAX_BODY_BYTES: String(LIMIT), UNKEY_ROOT_KEY: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => { try { child.kill('SIGKILL') } catch {} })
const B = `http://localhost:${PORT}`
const hdr = { Authorization: `Bearer ${BYPASS}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_body' }
const rawPost = (path, body, ct = 'application/json') =>
  fetch(`${B}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${BYPASS}`, 'Content-Type': ct, 'X-Shotbase-User-Id': 'user_body' }, body })

// Build a JSON body of an exact byte length (pad a field with 'a's).
function jsonOfSize(n) {
  const base = { url: 'http://localhost/', pad: '' } // localhost → SSRF-blocked → fast 400 if it passes bodyLimit
  const overhead = Buffer.byteLength(JSON.stringify(base))
  base.pad = 'a'.repeat(Math.max(0, n - overhead))
  let s = JSON.stringify(base)
  if (Buffer.byteLength(s) > n) base.pad = base.pad.slice(0, base.pad.length - (Buffer.byteLength(s) - n))
  return JSON.stringify(base)
}

let up = false
for (let i = 0; i < 30; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break } } catch {} await sleep(500) }
if (!up) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

try {
  // Below limit → passes bodyLimit (reaches handler; localhost URL → 400 Blocked URL, NOT 413)
  const small = await rawPost('/screenshot', jsonOfSize(200))
  assert(small.status !== 413 && small.status === 400, `below limit passes body check (got ${small.status}, expected 400 Blocked URL)`)

  // Boundary: exactly at limit → not 413; one over → 413
  const atLimit = await rawPost('/screenshot', jsonOfSize(LIMIT))
  assert(atLimit.status !== 413, `body == ${LIMIT}B not rejected (got ${atLimit.status})`)
  const overByOne = await rawPost('/screenshot', jsonOfSize(LIMIT + 1))
  assert(overByOne.status === 413, `body == ${LIMIT + 1}B → 413 (got ${overByOne.status})`)

  // Well above limit → 413 with clean REST error
  const big = await rawPost('/screenshot', jsonOfSize(LIMIT * 4))
  const bigBody = await big.json().catch(() => ({}))
  assert(big.status === 413 && /too large/i.test(bigBody.error ?? ''), `oversized → 413 "${bigBody.error}"`)

  // Malformed oversized (not JSON) → still rejected on size, no crash
  const garbage = await rawPost('/screenshot', 'x'.repeat(LIMIT * 4), 'text/plain')
  assert(garbage.status === 413, `malformed oversized body → 413 (got ${garbage.status}), no parse attempted`)

  // MCP oversized → 413 with JSON-RPC error shape (id:null)
  const mcpBig = await rawPost('/api/mcp', 'y'.repeat(LIMIT * 4))
  const mcpBody = await mcpBig.json().catch(() => ({}))
  assert(mcpBig.status === 413 && mcpBody?.error?.code === -32600, `MCP oversized → 413 JSON-RPC error (got ${mcpBig.status} ${JSON.stringify(mcpBody?.error)})`)

  // /health stays responsive right after the oversized burst
  const t0 = Date.now()
  const h = await fetch(`${B}/health`)
  assert(h.status === 200 && (Date.now() - t0) < 1000, `/health responsive after oversized requests (${Date.now() - t0}ms)`)
} finally { try { child.kill('SIGKILL') } catch {} }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
