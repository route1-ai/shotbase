// remove_popups DOM cleanup (REMOVE_POPUPS_SCRIPT) — deterministic, via Playwright
// against a committed fixture (real captures can't target a local file through the
// backend: the SSRF guard blocks it). Proves the cleanup walks OPEN shadow roots to
// remove consent/newsletter overlays while preserving a real sticky top nav.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from 'playwright'
import { REMOVE_POPUPS_SCRIPT } from '../dist/server.js'

let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))

const fixture = 'file://' + join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'shadow-consent.html')
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] })
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(fixture, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(100)

  const q = (sel, id) => page.evaluate(([s, i]) => !!document.querySelector(s)?.shadowRoot?.getElementById(i), [sel, id])
  const bannerBefore = await q('consent-widget', 'banner')
  const modalBefore = await q('newsletter-widget', 'modal')
  const navBefore = await page.evaluate(() => !!document.getElementById('nav'))
  assert(bannerBefore && modalBefore && navBefore, `fixture loaded: shadow consent banner + newsletter modal + real nav present`)

  const removed = await page.evaluate(REMOVE_POPUPS_SCRIPT)

  const bannerAfter = await q('consent-widget', 'banner')
  const modalAfter = await q('newsletter-widget', 'modal')
  const navAfter = await page.evaluate(() => !!document.getElementById('nav'))
  assert(removed >= 2, `cleanup removed ${removed} element(s) (>=2 across shadow roots)`)
  assert(bannerAfter === false, `consent banner in OPEN shadow root removed (after=${bannerAfter})`)
  assert(modalAfter === false, `newsletter modal in OPEN shadow root removed (after=${modalAfter})`)
  assert(navAfter === true, `real sticky top nav PRESERVED (after=${navAfter})`)

  await ctx.close()
} finally {
  await browser.close()
}
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
