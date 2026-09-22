// Render-option contract (perf/capture-latency): wait_until/delay_ms/block_ads/
// remove_popups/dark_mode/device_scale_factor validation, REST data-mode skipping the
// screenshot, Server-Timing on both response types, DSF scaling, and the data cache.
// Self-contained: spawns the backend (dev API key; no Supabase/Redis). Needs the
// local Playwright browser + network (uses https://example.com).
//
// Requires SB_KEY (used as an API_KEYS dev key here).

import { spawn } from 'node:child_process'
import sharp from 'sharp'

// This suite fires many requests; the rate limiter now runs BEFORE validation (a
// flood of even-invalid requests is throttled), so give each request its own dev
// key (all free plan) to keep the free 10 rpm limit from masking the behavior.
const KEYS = Array.from({ length: 60 }, (_, i) => `dk${i}`)
let keyN = 0
const nextKey = () => KEYS[keyN++ % KEYS.length]
const URL_ = process.env.SB_URL ?? 'https://example.com'
const PORT = 3991

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn('node', ['dist/server.js'], {
  env: { ...process.env, PORT: String(PORT), API_KEYS: KEYS.join(','), UNKEY_ROOT_KEY: '', PLAYGROUND_BYPASS_KEY: '', SUPABASE_URL: '', REDIS_URL: '' },
  stdio: ['ignore', 'ignore', 'inherit'],
})
function cleanup() { try { child.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)

const hdr = () => ({ Authorization: `Bearer ${nextKey()}`, 'Content-Type': 'application/json' })
async function post(body) {
  const r = await fetch(`http://localhost:${PORT}/screenshot`, { method: 'POST', headers: hdr(), body: JSON.stringify(body), signal: AbortSignal.timeout(60000) })
  const ct = r.headers.get('content-type') || ''
  const buf = Buffer.from(await r.arrayBuffer())
  const json = ct.includes('application/json') ? JSON.parse(buf.toString()) : null
  return { status: r.status, ct, bytes: buf.length, json, serverTiming: r.headers.get('server-timing') }
}
async function up() { for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://localhost:${PORT}/health`)).ok) return true } catch {} await sleep(500) } return false }
if (!(await up())) { bad('server failed to start'); console.log(`\n${pass} passed, ${fail} failed`); cleanup(); process.exit(1) }

try {
  // ── Validation: each invalid render option → 400 ──
  const rejects = [
    ['wait_until bad', { url: URL_, wait_until: 'bogus' }],
    ['delay_ms negative', { url: URL_, delay_ms: -1 }],
    ['delay_ms too big', { url: URL_, delay_ms: 10001 }],
    ['delay_ms non-int', { url: URL_, delay_ms: 1.5 }],
    ['block_ads non-bool', { url: URL_, block_ads: 'yes' }],
    ['remove_popups non-bool', { url: URL_, remove_popups: 1 }],
    ['dark_mode non-bool', { url: URL_, dark_mode: 'dark' }],
    ['device_scale_factor too big', { url: URL_, device_scale_factor: 4 }],
    ['device_scale_factor too small', { url: URL_, device_scale_factor: 0.5 }],
  ]
  for (const [name, body] of rejects) {
    const r = await post(body)
    assert(r.status === 400 && r.json?.error, `${name} → 400 "${r.json?.error}"`)
  }

  // ── Valid wait_until values are accepted ──
  for (const wu of ['load', 'domcontentloaded', 'networkidle', 'commit']) {
    const r = await post({ url: URL_, wait_until: wu, delay_ms: 0 })
    assert(r.status === 200 && r.ct.startsWith('image/'), `wait_until=${wu} → 200 image`)
  }

  // ── Plain image carries Server-Timing (binary response) ──
  const plain = await post({ url: URL_ })
  assert(plain.status === 200 && plain.ct.startsWith('image/') && /goto;dur=\d+/.test(plain.serverTiming || ''),
    `plain image → Server-Timing header present ("${(plain.serverTiming || '').slice(0, 40)}…")`)

  // ── REST data mode: JSON, screenshot_url null, screenshot stage skipped, Server-Timing ──
  const data = await post({ url: URL_, include_text: true })
  const stObj = Object.fromEntries((data.serverTiming || '').split(',').map((s) => s.trim().split(';')).map(([k, d]) => [k, Number((d || '').replace('dur=', ''))]))
  assert(data.status === 200 && data.ct.includes('application/json') && data.json.screenshot_url === null && typeof data.json.text === 'string',
    `include_text → JSON with screenshot_url:null + text (len=${data.json?.text?.length})`)
  assert(stObj.screenshot === 0, `data mode SKIPS the screenshot (screenshot;dur=${stObj.screenshot})`)
  assert(/page_text;dur=\d+/.test(data.serverTiming || ''), `data mode Server-Timing has page_text stage`)

  // ── Data-mode cache: 2nd identical request is a hit ──
  const data2 = await post({ url: URL_, include_text: true })
  assert(data2.status === 200 && data2.json.cached === true, `2nd include_text → data-cache hit (cached=${data2.json?.cached})`)

  // ── device_scale_factor scales the pixel dimensions ──
  const dsfImg = await fetch(`http://localhost:${PORT}/screenshot`, { method: 'POST', headers: hdr(), body: JSON.stringify({ url: URL_, width: 800, height: 600, device_scale_factor: 2 }) })
  const dsfMeta = await sharp(Buffer.from(await dsfImg.arrayBuffer())).metadata()
  assert(dsfMeta.width === 1600 && dsfMeta.height >= 1200, `device_scale_factor=2 @800×600 → ${dsfMeta.width}×${dsfMeta.height} px`)

  // ── dark_mode renders a valid image ──
  const dark = await post({ url: URL_, dark_mode: true })
  assert(dark.status === 200 && dark.ct.startsWith('image/') && dark.bytes > 1000, `dark_mode=true → 200 image (${dark.bytes} bytes)`)

  // ── block_ads / remove_popups accepted (no error) on a plain page ──
  const ba = await post({ url: URL_, block_ads: true, remove_popups: true })
  assert(ba.status === 200, `block_ads + remove_popups together → 200`)
} finally { cleanup() }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
