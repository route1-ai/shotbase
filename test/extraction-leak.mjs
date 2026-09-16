// Provider-error leak test for the AI-extraction path (REST + MCP).
// Self-contained: spawns the backend with INTENTIONALLY INVALID AWS creds so
// bedrockClient initializes but every Converse call fails with a provider error.
// Asserts the client never receives raw AWS/provider internals — only the generic
// "AI extraction temporarily unavailable" message. Deterministic regardless of the
// real account's Bedrock access state.
//
// Requires SB_KEY (the PLAYGROUND_BYPASS_KEY value) in env. Uses https://example.com.

import { spawn } from 'node:child_process'

const BYPASS = process.env.SB_KEY
if (!BYPASS) { console.error('FATAL: SB_KEY (PLAYGROUND_BYPASS_KEY value) is required.'); process.exit(2) }
const URL_ = 'https://example.com'
const PORT = 3943
const GENERIC = 'AI extraction temporarily unavailable'
// Substrings that would indicate a raw provider error leaked to the client.
const FORBIDDEN = ['account', 'use case', 'submitted', 'iam', 'arn:', 'security token',
  'accessdenied', 'resourcenotfound', 'credential', 'anthropic.claude', 'inference profile', 'bedrock']

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (s) => { const low = String(s).toLowerCase(); return FORBIDDEN.filter((f) => low.includes(f)) }

const child = spawn('node', ['dist/server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PLAYGROUND_BYPASS_KEY: BYPASS,
    // Invalid-but-present AWS creds → bedrockClient initializes, Converse always fails.
    AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: 'AKIAINVALIDTESTKEY000',
    AWS_SECRET_ACCESS_KEY: 'invalidsecret0000000000000000000000000000',
    UNKEY_ROOT_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
})
process.on('exit', () => { try { child.kill('SIGKILL') } catch {} })

const hdr = { Authorization: `Bearer ${BYPASS}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_leaktest' }
const B = `http://localhost:${PORT}`
let up = false
for (let i = 0; i < 30; i++) { try { if ((await fetch(`${B}/health`)).ok) { up = true; break } } catch {} await sleep(500) }
if (!up) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); process.exit(1) }

try {
  // Confirm bedrock initialized (so ai_extract actually calls the provider and fails)
  const health = await (await fetch(`${B}/health`)).json()
  assert(health.bedrock === true, `bedrock client initialized (health.bedrock=${health.bedrock})`)

  // REST ai_extract → provider fails → sanitized 500, no leak
  const res = await fetch(`${B}/screenshot`, { method: 'POST', headers: hdr,
    body: JSON.stringify({ url: URL_, ai_extract: { page_type: true, headings: true, ctas: true, prices: true } }) })
  const bodyText = await res.text()
  let body = null; try { body = JSON.parse(bodyText) } catch {}
  assert(res.status === 500, `REST ai_extract failure → HTTP 500 (got ${res.status})`)
  assert(body?.error === GENERIC, `REST error message is generic (got ${JSON.stringify(body?.error)})`)
  assert(body?.detail === undefined, `REST response carries no "detail" field (got ${JSON.stringify(body?.detail)})`)
  const restLeaks = clean(bodyText)
  assert(restLeaks.length === 0, `REST body leaks no provider internals${restLeaks.length ? ' — LEAKED: ' + restLeaks.join(',') : ''}`)

  // MCP extract:true → provider fails → image kept + generic marker, no leak
  const mres = await fetch(`${B}/api/mcp`, { method: 'POST', headers: hdr,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shotbase_capture', arguments: { url: URL_, extract: true } } }) })
  const mtext = await mres.text()
  const m = JSON.parse(mtext)
  const content = m?.result?.content ?? []
  const hasImage = content.some((b) => b.type === 'image')
  const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text)
  assert(hasImage && m?.result?.isError === false, `MCP keeps image + isError:false (image=${hasImage})`)
  assert(textBlocks.some((t) => t.includes(GENERIC)), `MCP degrades with generic marker (got ${JSON.stringify(textBlocks)})`)
  // Scan only client-facing TEXT (not the base64 image bytes, which can contain
  // arbitrary substrings like "iam" by coincidence).
  const mcpLeaks = clean(textBlocks.join(' '))
  assert(mcpLeaks.length === 0, `MCP body leaks no provider internals${mcpLeaks.length ? ' — LEAKED: ' + mcpLeaks.join(',') : ''}`)
} finally {
  try { child.kill('SIGKILL') } catch {}
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
