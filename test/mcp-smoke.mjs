// Stage 2 MCP smoke test (SPEC_MCP_SERVER.md §7). No test-runner dependency.
// Assumes the server is running. Configure via env:
//   MCP_BASE (default http://localhost:3940)  MCP_KEY (default playground_bypass)
//   SMOKE_URL (default https://example.com)
// Exit 0 if all REQUIRED assertions pass (the extract-JSON assertion DEFERS while the
// model is unreachable and turns into a real PASS automatically once it returns JSON).

const BASE = process.env.MCP_BASE ?? 'http://localhost:3940'
const KEY  = process.env.MCP_KEY  ?? 'playground_bypass'
const URL_ = process.env.SMOKE_URL ?? 'https://example.com'
const MCP = `${BASE}/api/mcp`

let pass = 0, fail = 0, deferred = 0
const ok   = (m) => { pass++;     console.log(`  PASS     ${m}`) }
const bad  = (m) => { fail++;     console.log(`  FAIL     ${m}`) }
const defer= (m) => { deferred++; console.log(`  DEFERRED ${m}`) }

async function rpc(method, params, key = KEY) {
  const res = await fetch(MCP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

console.log(`MCP smoke → ${MCP}  (key: ${KEY.slice(0, 8)}…)\n`)

// 1. initialize + tools/list → shotbase_capture present
const init = await rpc('initialize', { protocolVersion: '2025-06-18' })
init.body?.result?.serverInfo?.name === 'shotbase' ? ok('initialize → serverInfo.name=shotbase')
  : bad(`initialize → unexpected: ${JSON.stringify(init.body)}`)

const list = await rpc('tools/list', {})
const tool = list.body?.result?.tools?.find((t) => t.name === 'shotbase_capture')
tool ? ok('tools/list → shotbase_capture present') : bad(`tools/list → tool missing: ${JSON.stringify(list.body)}`)
tool?.inputSchema?.required?.includes('url') ? ok('shotbase_capture.inputSchema requires "url"') : bad('inputSchema missing required url')

// 2. tools/call extract:true → image block REQUIRED; structuredContent DEFERRED until model reachable
const call = await rpc('tools/call', { name: 'shotbase_capture', arguments: { url: URL_, extract: true } })
const content = call.body?.result?.content ?? []
const imageBlock = content.find((b) => b.type === 'image')
imageBlock?.data?.length > 100 ? ok(`tools/call → image block present (${imageBlock.data.length} b64 chars, ${imageBlock.mimeType})`)
  : bad(`tools/call → no image block: ${JSON.stringify(call.body).slice(0, 200)}`)

const sc = call.body?.result?.structuredContent
const textBlock = content.find((b) => b.type === 'text')?.text ?? ''
if (sc && Object.keys(sc).length > 0) {
  ok(`tools/call → structuredContent present (keys: ${Object.keys(sc).join(',')})`)
  sc.page_type !== undefined ? ok('structuredContent.page_type present') : defer('structuredContent has no page_type yet (prompt tune)')
} else if (textBlock.startsWith('extraction_unavailable')) {
  defer(`extract JSON pending model unblock → "${textBlock.slice(0, 70)}"`)
} else {
  bad(`tools/call → no structuredContent and no extraction_unavailable marker: ${JSON.stringify(call.body).slice(0, 200)}`)
}

// 3. bad key → -32001 unauthorized
const unauth = await rpc('tools/call', { name: 'shotbase_capture', arguments: { url: URL_ } }, 'definitely_invalid_key')
unauth.body?.error?.code === -32001 ? ok('bad key → -32001 unauthorized')
  : bad(`bad key → expected -32001, got: ${JSON.stringify(unauth.body)}`)

// bonus: GET /api/mcp → 405
const get = await fetch(MCP).then((r) => r.status)
get === 405 ? ok('GET /api/mcp → 405') : bad(`GET /api/mcp → expected 405, got ${get}`)

console.log(`\n${pass} passed, ${deferred} deferred, ${fail} failed`)
if (deferred) console.log('(deferred = blocked only on the AWS/Bedrock unblock; flips to PASS automatically)')
process.exit(fail > 0 ? 1 : 0)
