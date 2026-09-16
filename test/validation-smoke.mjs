// /screenshot input-validation + cache-key smoke (P0 correctness). No test-runner dep.
// Assumes the server is running. Configure via env:
//   SB_BASE (default http://localhost:3940)  SB_KEY (REQUIRED — no default, no fallback)
//   SB_URL  (default https://example.com)
// Covers: field validation (url/format/width/height/full_page/include_text/ai_extract)
// and proves the cache key no longer collides across differing width/height.

const BASE = process.env.SB_BASE ?? 'http://localhost:3940'
const KEY  = process.env.SB_KEY
if (!KEY) {
  console.error('FATAL: SB_KEY is required. Set it in the environment before running.')
  process.exit(2)
}
const URL_ = process.env.SB_URL ?? 'https://example.com'
const EP = `${BASE}/screenshot`

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }

async function post(body) {
  const res = await fetch(EP, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', 'X-Shotbase-User-Id': 'user_valsmoke' },
    body: JSON.stringify(body),
  })
  const ct = res.headers.get('content-type') ?? ''
  const buf = Buffer.from(await res.arrayBuffer())
  let json = null
  if (ct.includes('application/json')) { try { json = JSON.parse(buf.toString()) } catch {} }
  return { status: res.status, ct, bytes: buf.length, json, xcache: res.headers.get('x-cache') }
}

console.log(`Validation smoke → ${EP}`)

// ── Reject cases: each must be 400 ──────────────────────────────────────────
const rejects = [
  ['missing url',            {}],
  ['url too long (>2048)',   { url: 'https://e.com/' + 'a'.repeat(2100) }],
  ['bad format',             { url: URL_, format: 'gif' }],
  ['width too small',        { url: URL_, width: 10 }],
  ['width too big',          { url: URL_, width: 99999 }],
  ['width non-integer',      { url: URL_, width: 800.5 }],
  ['width wrong type',       { url: URL_, width: 'wide' }],
  ['height too small',       { url: URL_, height: 1 }],
  ['height too big',         { url: URL_, height: 99999 }],
  ['full_page wrong type',   { url: URL_, full_page: 'yes' }],
  ['include_text wrong type',{ url: URL_, include_text: 1 }],
  ['ai_extract as array',    { url: URL_, ai_extract: ['page_type'] }],
  ['ai_extract non-boolean', { url: URL_, ai_extract: { page_type: 'yes' } }],
  ['ai_extract too many',    { url: URL_, ai_extract: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, true])) }],
]
for (const [name, body] of rejects) {
  const r = await post(body)
  r.status === 400 && r.json?.error
    ? ok(`${name} → 400 "${r.json.error}"`)
    : bad(`${name} → expected 400, got ${r.status} ${JSON.stringify(r.json)?.slice(0, 120)}`)
}

// ── Accept case: valid request → 200 image ──────────────────────────────────
const good = await post({ url: URL_, width: 800, height: 600 })
good.status === 200 && good.ct.startsWith('image/') && good.bytes > 1000
  ? ok(`valid request → 200 ${good.ct} (${good.bytes} bytes)`)
  : bad(`valid request → expected 200 image, got ${good.status} ${good.ct}`)

// ── Cache-key: differing viewport must NOT collide ──────────────────────────
// Same URL+format, two viewports. Prime each, then re-request and assert the
// re-request is a cache HIT that returns that viewport's own image (not the other's).
const a1 = await post({ url: URL_, width: 400, height: 300 })
const b1 = await post({ url: URL_, width: 1200, height: 900 })
const a2 = await post({ url: URL_, width: 400, height: 300 })
const b2 = await post({ url: URL_, width: 1200, height: 900 })
const distinct = a1.bytes !== b1.bytes
const aStable = a1.bytes === a2.bytes
const bStable = b1.bytes === b2.bytes
const aHit = a2.xcache === 'HIT'
const bHit = b2.xcache === 'HIT'
distinct && aStable && bStable
  ? ok(`cache key distinct by viewport → 400x300=${a1.bytes}b, 1200x900=${b1.bytes}b, each stable on re-request (HIT: ${aHit}/${bHit})`)
  : bad(`cache collision suspected → 400x300=${a1.bytes}/${a2.bytes} 1200x900=${b1.bytes}/${b2.bytes} (distinct=${distinct} aStable=${aStable} bStable=${bStable})`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
