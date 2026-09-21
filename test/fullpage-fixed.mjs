// Fixed/sticky top-element preservation — deterministic tests.
//  Part A: pure orchestration (screenshotWithFixedOverlay) — cleanup/restore on error.
//  Part B: the REAL generic detect/hide/restore functions driven by Playwright against
//          a committed local fixture (no backend → no SSRF block; no network).
// Proves: top fixed + sticky detected & composited ONCE; bottom chat widget ignored;
// hide removes stray copy; restore is exact; lazy/reveal persist (leave-at-bottom).

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { DETECT_FIXED, HIDE_FIXED, RESTORE_FIXED, screenshotWithFixedOverlay } from '../dist/server.js'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))

// ── Part A: orchestration (no browser) ───────────────────────────────────────
console.log('── screenshotWithFixedOverlay (cleanup on error) ──')
{
  const calls = []
  const out = await screenshotWithFixedOverlay({
    hide: async () => { calls.push('hide') },
    screenshotPng: async () => { calls.push('shot'); return Buffer.from('BASE') },
    restore: async () => { calls.push('restore') },
    composite: async (base) => { calls.push('composite:' + base.toString()); return Buffer.from('OUT') },
  })
  assert(out.toString() === 'OUT' && calls.join(',') === 'hide,shot,restore,composite:BASE',
    `normal flow order = ${calls.join(',')}`)
}
{
  const calls = []
  let threw = false
  try {
    await screenshotWithFixedOverlay({
      hide: async () => { calls.push('hide') },
      screenshotPng: async () => { calls.push('shot'); throw new Error('screenshot boom') },
      restore: async () => { calls.push('restore') },
      composite: async () => { calls.push('composite'); return Buffer.from('OUT') },
    })
  } catch { threw = true }
  assert(threw && calls.includes('restore') && !calls.includes('composite'),
    `screenshot throw → restore STILL runs, no composite, error propagates (calls=${calls.join(',')})`)
}

// ── Part B: real detection + hide/restore + composite on the fixture ──────────
console.log('\n── generic detect/hide/restore against fixture (Playwright) ──')
const __dirname = dirname(fileURLToPath(import.meta.url))
const fixtureUrl = 'file://' + join(__dirname, 'fixtures', 'fixed-elements.html')
const RED = [225, 29, 29], ORANGE = [245, 158, 11]
const near = (p, c, t = 45) => Math.abs(p[0] - c[0]) < t && Math.abs(p[1] - c[1]) < t && Math.abs(p[2] - c[2]) < t
async function colorBands(png, color, minFrac = 0.5) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, ch = info.channels, bands = []
  let inb = false, st = 0
  for (let y = 0; y < H; y += 4) {
    let c = 0, n = 0
    for (let x = 0; x < W; x += 8) { n++; const o = (y * W + x) * ch; if (near([data[o], data[o + 1], data[o + 2]], color)) c++ }
    if (c / n >= minFrac) { if (!inb) { inb = true; st = y } } else if (inb) { inb = false; bands.push([st, y]) }
  }
  if (inb) bands.push([st, H])
  return bands
}

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
const S = process.env.TMP_OUT || dirname(fileURLToPath(import.meta.url))
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(150)

  // Detect (page at top)
  const det = await page.evaluate(DETECT_FIXED, 240)
  assert(det.count === 2 && det.overlayHeight === 140,
    `detects top fixed + sticky only (count=${det.count}, overlayHeight=${det.overlayHeight})`)

  // Bottom chat widget must NOT be detected (req: bottom widget not moved to top)
  const chatMarked = await page.evaluate(() => document.getElementById('chat').hasAttribute('data-sb-fixed'))
  const headerMarked = await page.evaluate(() => document.getElementById('fixedHeader').hasAttribute('data-sb-fixed'))
  const stickyMarked = await page.evaluate(() => document.getElementById('stickyBar').hasAttribute('data-sb-fixed'))
  assert(headerMarked && stickyMarked && !chatMarked,
    `fixed header + sticky marked, bottom chat widget NOT marked (header=${headerMarked}, sticky=${stickyMarked}, chat=${chatMarked})`)

  // Snapshot the top overlay
  const overlay = await page.screenshot({ clip: { x: 0, y: 0, width: 1440, height: det.overlayHeight } })

  // Prepass to bottom (triggers lazy + reveal)
  for (let i = 0; i < 50; i++) {
    const m = await page.evaluate(() => ({ y: window.scrollY, vh: window.innerHeight, sh: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }))
    if (m.y + m.vh >= m.sh - 2) break
    await page.evaluate((t) => window.scrollTo(0, t), Math.min(m.y + Math.round(900 * 0.85), 40000))
    await page.waitForTimeout(60)
  }
  const lazyLoaded = await page.evaluate(() => document.getElementById('lazy').classList.contains('loaded'))
  const revealOpacity = await page.evaluate(() => getComputedStyle(document.getElementById('reveal')).opacity)
  assert(lazyLoaded && revealOpacity === '1', `lazy + play-once reveal triggered by prepass and PERSIST at bottom (lazy=${lazyLoaded}, revealOpacity=${revealOpacity})`)

  // Record original inline visibility, then HIDE
  const origHeaderVis = await page.evaluate(() => document.getElementById('fixedHeader').style.visibility)
  await page.evaluate(HIDE_FIXED)
  const hiddenHeaderVis = await page.evaluate(() => document.getElementById('fixedHeader').style.visibility)
  const chatVisAfterHide = await page.evaluate(() => document.getElementById('chat').style.visibility)
  assert(hiddenHeaderVis === 'hidden' && chatVisAfterHide !== 'hidden',
    `HIDE hides marked header (vis=${hiddenHeaderVis}) but leaves chat widget untouched (chatVis="${chatVisAfterHide}")`)

  // Full-page shot with fixed hidden → NO stray red header band anywhere
  const rawPath = join(S, 'ff_raw.png')
  await page.screenshot({ path: rawPath, fullPage: true })
  const rawRed = await colorBands(rawPath, RED)
  assert(rawRed.length === 0, `no stray fixed header in the hidden full-page shot (red bands=${JSON.stringify(rawRed)})`)

  // RESTORE — exact
  await page.evaluate(RESTORE_FIXED)
  const restoredVis = await page.evaluate(() => document.getElementById('fixedHeader').style.visibility)
  const attrGone = await page.evaluate(() => !document.getElementById('fixedHeader').hasAttribute('data-sb-fixed'))
  assert(restoredVis === origHeaderVis && attrGone, `RESTORE returns visibility exactly ("${restoredVis}"==="${origHeaderVis}") and removes marker (attrGone=${attrGone})`)

  // Composite overlay → header appears exactly once at the top
  const outPath = join(S, 'ff_composite.png')
  await sharp(rawPath).composite([{ input: overlay, top: 0, left: 0 }]).png().toFile(outPath)
  const compRed = await colorBands(outPath, RED)
  const compOrange = await colorBands(outPath, ORANGE)
  assert(compRed.length === 1 && compRed[0][0] === 0 && compRed[0][1] <= 64,
    `composite: fixed header appears ONCE at the top (red bands=${JSON.stringify(compRed)})`)
  assert(compOrange.length === 1 && compOrange[0][0] >= 96 && compOrange[0][1] <= 148,
    `composite: sticky bar preserved at its top position once (orange bands=${JSON.stringify(compOrange)})`)

  await ctx.close()
} finally {
  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
