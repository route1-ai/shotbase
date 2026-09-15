// BrowserGate unit tests (P0 browser concurrency protection). No test-runner dep.
// Tests the REAL gate class imported from the built server (importing does not
// start a listener — bootstrap is guarded by require.main === module).
//
// Why a unit test and not HTTP: the SSRF guard blocks every local/private target,
// so overlapping real captures can't be driven at a controllable local URL. The
// gate logic is tested directly here; end-to-end 503 + /health is in overload-http.mjs.

import { BrowserGate, GateError } from '../dist/server.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const assert = (cond, m) => (cond ? ok(m) : bad(m))

// Mirror performCapture's usage exactly: acquire → try/(catch)/finally release.
async function runGated(gate, work) {
  let permit
  try {
    permit = await gate.acquire()
  } catch (e) {
    return { acquired: false, kind: e instanceof GateError ? e.kind : 'unknown' }
  }
  try {
    const value = await work()
    return { acquired: true, ok: true, value }
  } catch (e) {
    return { acquired: true, ok: false, error: e.message }
  } finally {
    permit.release() // ALWAYS
  }
}

// 1) Active concurrency never exceeds the configured maximum.
{
  const gate = new BrowserGate(3, 100, 5000)
  let active = 0, peak = 0
  const job = () => runGated(gate, async () => { active++; peak = Math.max(peak, active); await sleep(40); active-- })
  const results = await Promise.all(Array.from({ length: 12 }, job))
  assert(peak <= 3, `active concurrency peak (${peak}) never exceeded max (3)`)
  assert(results.every((r) => r.acquired && r.ok), 'all 12 jobs eventually ran')
  assert(gate.activeCount === 0 && gate.queuedCount === 0, `gate drained to 0/0 (active=${gate.activeCount} queued=${gate.queuedCount})`)
}

// 2) Queued requests eventually execute.
{
  const gate = new BrowserGate(2, 20, 5000)
  let done = 0
  const results = await Promise.all(Array.from({ length: 8 }, () => runGated(gate, async () => { await sleep(20); done++ })))
  assert(done === 8 && results.every((r) => r.acquired), 'all 8 queued jobs executed (none dropped)')
}

// 3) Queue-full rejection (bounded memory).
{
  const gate = new BrowserGate(1, 1, 5000) // 1 active + 1 queued max
  const results = await Promise.all([
    runGated(gate, () => sleep(60)),
    runGated(gate, () => sleep(60)),
    runGated(gate, () => sleep(60)),
  ])
  const rejected = results.filter((r) => !r.acquired)
  const ran = results.filter((r) => r.acquired && r.ok)
  assert(rejected.length === 1 && rejected[0].kind === 'overloaded', `exactly 1 rejected with kind 'overloaded' (got ${rejected.length}: ${rejected.map((r) => r.kind)})`)
  assert(ran.length === 2, `the other 2 (1 active + 1 queued) ran (got ${ran.length})`)
}

// 4) Queue-timeout behavior.
{
  const gate = new BrowserGate(1, 5, 40) // 40ms wait budget
  const [r1, r2] = await Promise.all([
    runGated(gate, () => sleep(200)),  // holds the only slot for 200ms
    runGated(gate, () => sleep(10)),   // queued; must time out at ~40ms
  ])
  assert(r1.acquired && r1.ok, 'slot holder completed')
  assert(!r2.acquired && r2.kind === 'timeout', `queued waiter rejected with 'timeout' (got ${r2.acquired ? 'ran' : r2.kind})`)
  await sleep(220)
  assert(gate.activeCount === 0, `no slot leaked after timeout (active=${gate.activeCount})`)
}

// 5) Slot released after a capture failure (work throws).
{
  const gate = new BrowserGate(1, 5, 5000)
  const r1 = await runGated(gate, async () => { throw new Error('capture boom') })
  const r2 = await runGated(gate, async () => 42) // only succeeds if the slot was freed
  assert(r1.acquired && r1.ok === false, 'failing job acquired then errored')
  assert(r2.acquired && r2.ok && r2.value === 42, 'next job acquired the freed slot (no leak on failure)')
  assert(gate.activeCount === 0, `gate back to 0 active (${gate.activeCount})`)
}

// 6) Double release is idempotent — must never over-grant a slot.
{
  const gate = new BrowserGate(2, 5, 5000)
  const p = await gate.acquire()
  p.release()
  p.release() // no-op
  const a = await gate.acquire()
  const b = await gate.acquire()
  assert(gate.activeCount === 2, `double-release did not over-grant (active=${gate.activeCount}, expected 2)`)
  a.release(); b.release()
  assert(gate.activeCount === 0, 'drained after releases')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
