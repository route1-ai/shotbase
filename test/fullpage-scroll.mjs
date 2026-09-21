// Bounded full-page scroll prepass — deterministic UNIT tests (no browser, no net).
// Drives the exported scrollPrepass() through a mock ScrollPage + a fake clock, so
// every safety bound and behavior is proven without timing flakiness. (Real captures
// can't target a local test server — the SSRF guard blocks private IPs.)

import { scrollPrepass, runScrollPrepass, BrowserGate } from '../dist/server.js'

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (c, m) => (c ? ok(m) : bad(m))

// A virtual page: fixed viewport, a (possibly growing) document, optional lazy
// threshold + IntersectionObserver-style section tops that "reveal" as they enter
// the viewport during traversal, and an optional throw injection.
function mockPage({ viewportHeight = 1000, initialHeight = 8000, grow = null, lazyThreshold = null, sectionTops = [], throwOn = null } = {}) {
  let scrollY = 0
  let scrollHeight = initialHeight
  const revealed = new Set()
  let lazyLoaded = false
  const detect = () => {
    for (const t of sectionTops) if (scrollY + viewportHeight >= t) revealed.add(t)
    if (lazyThreshold != null && scrollY + viewportHeight >= lazyThreshold) lazyLoaded = true
  }
  const page = {
    async metrics() {
      if (throwOn === 'metrics') throw new Error('metrics boom')
      detect()
      return { scrollY, viewportHeight, scrollHeight }
    },
    async scrollTo(y) {
      if (throwOn === 'scrollTo') throw new Error('scroll boom')
      scrollY = Math.max(0, Math.min(y, Math.max(0, scrollHeight - viewportHeight)))
      if (grow) scrollHeight = grow(scrollHeight, scrollY)
      detect()
    },
    async wait(ms) { clock.t += ms },
  }
  const state = {
    get scrollY() { return scrollY },
    get scrollHeight() { return scrollHeight },
    get viewportHeight() { return viewportHeight },
    revealed,
    get lazyLoaded() { return lazyLoaded },
    atBottom() { return scrollY + viewportHeight >= scrollHeight - 2 },
  }
  return { page, state }
}

let clock = { t: 0 }
const now = () => clock.t
const baseOpts = (o = {}) => ({ stepRatio: 0.85, stepWaitMs: 0, maxSteps: 50, maxMs: 999_999, maxHeightPx: 200_000, now, ...o })
const reset = () => { clock = { t: 0 } }

// ── A) short page: nothing to scroll ─────────────────────────────────────────
reset()
{
  const { page } = mockPage({ initialHeight: 600, viewportHeight: 1000 })
  const d = await scrollPrepass(page, baseOpts())
  assert(d.steps === 0 && !d.boundHit && d.initialHeight === 600, `short page (600<vp) → 0 steps, no bound (steps=${d.steps})`)
}

// ── B) tall static page reaches the true bottom, no bound ────────────────────
reset()
{
  const { page, state } = mockPage({ initialHeight: 8000, viewportHeight: 1000 })
  const d = await scrollPrepass(page, baseOpts())
  assert(state.atBottom() && d.steps > 0 && d.steps < 50 && !d.boundHit,
    `tall page → reached bottom in ${d.steps} steps, no bound hit`)
}

// ── C) lazy content only reachable by scrolling is triggered ─────────────────
reset()
{
  const { page, state } = mockPage({ initialHeight: 8000, viewportHeight: 1000, lazyThreshold: 6000 })
  const before = state.lazyLoaded
  const d = await scrollPrepass(page, baseOpts())
  assert(before === false && state.lazyLoaded === true, `lazy element @6000px triggered by prepass (before=${before}, after=${state.lazyLoaded}, steps=${d.steps})`)
}

// ── D) IntersectionObserver-style sections all activate ──────────────────────
reset()
{
  const tops = [1000, 3000, 5000, 7000, 7900]
  const { page, state } = mockPage({ initialHeight: 8000, viewportHeight: 1000, sectionTops: tops })
  await scrollPrepass(page, baseOpts())
  assert(state.revealed.size === tops.length, `all ${tops.length} IO sections revealed during traversal (got ${state.revealed.size})`)
}

// ── E) document height growth is followed (within bounds) ────────────────────
reset()
{
  // Lazy content appends until 12000, then stabilizes.
  const grow = (sh) => (sh < 12_000 ? sh + 2_000 : sh)
  const { page, state } = mockPage({ initialHeight: 6000, viewportHeight: 1000, grow })
  const d = await scrollPrepass(page, baseOpts())
  assert(d.initialHeight === 6000 && d.maxHeight === 12_000 && state.atBottom() && !d.boundHit,
    `height grew 6000→12000, followed to bottom, no bound (initial=${d.initialHeight}, max=${d.maxHeight}, bottom=${state.atBottom()})`)
}

// ── F) infinite-growth feed terminates at max_steps ──────────────────────────
reset()
{
  const grow = (sh) => sh + 2_000 // grows faster than a step every time → never bottoms out
  const { page } = mockPage({ initialHeight: 6000, viewportHeight: 1000, grow })
  const d = await scrollPrepass(page, baseOpts({ maxSteps: 40 }))
  assert(d.boundHit && d.boundReason === 'max_steps' && d.steps === 40, `infinite feed → stopped at max_steps=40 (reason=${d.boundReason}, steps=${d.steps})`)
}

// ── G) cannot run forever: max_ms bound via fake clock ───────────────────────
reset()
{
  const grow = (sh) => sh + 2_000
  const { page } = mockPage({ initialHeight: 6000, viewportHeight: 1000, grow })
  // each step waits 200ms (advances fake clock); maxMs=1000 → ~5 steps then stop.
  const d = await scrollPrepass(page, baseOpts({ stepWaitMs: 200, maxMs: 1000, maxSteps: 100_000 }))
  assert(d.boundHit && d.boundReason === 'max_ms' && d.steps <= 6 && d.ms >= 1000,
    `time bound → stopped at max_ms=1000 after ${d.steps} steps (reason=${d.boundReason}, ms=${d.ms})`)
}

// ── H) hard height ceiling bound ─────────────────────────────────────────────
reset()
{
  const { page } = mockPage({ initialHeight: 250_000, viewportHeight: 1000 })
  const d = await scrollPrepass(page, baseOpts({ maxHeightPx: 40_000 }))
  assert(d.boundHit && d.boundReason === 'max_height', `document over ceiling → stopped at max_height (reason=${d.boundReason}, steps=${d.steps})`)
}

// ── I) errors propagate (prepass throws → caller can catch + release permit) ──
reset()
{
  const { page } = mockPage({ throwOn: 'metrics' })
  let threw = false
  try { await scrollPrepass(page, baseOpts()) } catch { threw = true }
  assert(threw, 'metrics() throw → scrollPrepass rejects (caller releases permit)')
}
reset()
{
  const { page } = mockPage({ initialHeight: 8000, viewportHeight: 1000, throwOn: 'scrollTo' })
  let threw = false
  try { await scrollPrepass(page, baseOpts()) } catch { threw = true }
  assert(threw, 'scrollTo() throw → scrollPrepass rejects')
}

// ── J) determinism: bounded step count can never exceed maxSteps ─────────────
reset()
{
  const grow = (sh) => sh + 5_000
  const { page } = mockPage({ initialHeight: 3000, viewportHeight: 800, grow })
  const d = await scrollPrepass(page, baseOpts({ maxSteps: 25, maxMs: 999_999 }))
  assert(d.steps <= 25, `step count never exceeds maxSteps (steps=${d.steps} <= 25)`)
}

// ── K) graceful failure handling — failure injected ONLY from the test ────────
// runScrollPrepass is the exact production wrapper. We inject a throwing prepass
// function (no production env var / runtime trigger) and prove: it degrades
// gracefully (error diag, no rethrow), and — composed with the REAL BrowserGate
// exactly like performCapture (acquire → prepass → finally release) — the permit
// is released, no slot leaks, and a subsequent request acquires the freed slot.
reset()
{
  const throwing = async () => { throw new Error('injected prepass failure') }
  const { page } = mockPage({ initialHeight: 8000, viewportHeight: 1000 })

  // Graceful: wrapper catches, returns an error-tagged diag, never rethrows.
  const diag = await runScrollPrepass(page, baseOpts(), throwing)
  assert(diag.error === true && diag.steps === 0, `injected prepass throw → graceful error diag, no rethrow (error=${diag.error})`)

  // Permit lifecycle mirroring performCapture's acquire → prepass → finally release.
  const gate = new BrowserGate(1, 0, 1000)
  const permit = await gate.acquire()
  assert(gate.activeCount === 1, 'gate: permit acquired (active=1)')
  let captureContinued = false
  try {
    const d = await runScrollPrepass(page, baseOpts(), throwing) // must NOT throw
    captureContinued = d.error === true // capture proceeds to screenshot after a failed prepass
  } finally {
    permit.release()
  }
  assert(captureContinued, 'capture CONTINUES after prepass failure (would proceed to screenshot)')
  assert(gate.activeCount === 0, 'BrowserGate permit RELEASED after prepass-failure path (no leak)')
  const p2 = await gate.acquire()
  assert(gate.activeCount === 1, 'subsequent request ACQUIRES the freed slot (no slot leak)')
  p2.release()
  assert(gate.activeCount === 0, 'gate drains to 0 after subsequent request')
}

// ── L) injected non-Error throw is still handled safely ──────────────────────
reset()
{
  const throwingStr = async () => { throw 'string failure' } // non-Error rejection
  const { page } = mockPage()
  const diag = await runScrollPrepass(page, baseOpts(), throwingStr)
  assert(diag.error === true, 'non-Error prepass rejection still degrades gracefully')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
