// Pricing v2 — plan configuration + normalization (pure unit test).
// Imports the centralized plan functions from the built server (no server spawn,
// no network, no Supabase). Proves the single source of truth matches the FINAL
// public contract exactly, and that legacy/unknown plans normalize safely.
//
//   Free     250 captures / 25 AI / 10 RPM
//   Builder  1,500       / 150      / 20
//   Pro      7,500       / 1,000    / 40
//   starter → builder,  scale → pro,  unknown/business/blank → free

import {
  PLAN_CONFIG,
  normalizePlan,
  getRateLimitPerMinute,
  getCaptureQuota,
  getAiExtractionQuota,
} from '../dist/server.js'

let pass = 0, fail = 0
const ok  = (m) => { pass++; console.log(`  PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`  FAIL  ${m}`) }
const eq  = (got, want, m) => (got === want ? ok(`${m} → ${got}`) : bad(`${m} → got ${got}, want ${want}`))

console.log('── PLAN_CONFIG values (final contract) ──')
eq(PLAN_CONFIG.free.captureLimit, 250, 'free captures')
eq(PLAN_CONFIG.free.aiExtractionLimit, 25, 'free AI extractions')
eq(PLAN_CONFIG.free.rpm, 10, 'free rpm')
eq(PLAN_CONFIG.builder.captureLimit, 1500, 'builder captures')
eq(PLAN_CONFIG.builder.aiExtractionLimit, 150, 'builder AI extractions')
eq(PLAN_CONFIG.builder.rpm, 20, 'builder rpm')
eq(PLAN_CONFIG.pro.captureLimit, 7500, 'pro captures')
eq(PLAN_CONFIG.pro.aiExtractionLimit, 1000, 'pro AI extractions')
eq(PLAN_CONFIG.pro.rpm, 40, 'pro rpm')
// Business must NOT exist as a self-serve tier with invented limits.
ok(!('business' in PLAN_CONFIG) ? 'no invented Business tier in PLAN_CONFIG' : (fail++, 'Business tier leaked into PLAN_CONFIG'))

console.log('\n── normalizePlan ──')
eq(normalizePlan('free'), 'free', "'free'")
eq(normalizePlan('Free'), 'free', "'Free' (case-insensitive)")
eq(normalizePlan('builder'), 'builder', "'builder'")
eq(normalizePlan('PRO'), 'pro', "'PRO' (case-insensitive)")
eq(normalizePlan('starter'), 'builder', "legacy 'starter' → builder")
eq(normalizePlan('scale'), 'pro', "legacy 'scale' → pro")
eq(normalizePlan('business'), 'free', "'business' → free (not auto-provisioned, lowest allowance)")
eq(normalizePlan('enterprise'), 'free', "unknown 'enterprise' → free")
eq(normalizePlan(''), 'free', "'' → free")
eq(normalizePlan('   '), 'free', "'   ' → free")
eq(normalizePlan(undefined), 'free', 'undefined → free')
eq(normalizePlan(null), 'free', 'null → free')

console.log('\n── getRateLimitPerMinute ──')
eq(getRateLimitPerMinute('free'), 10, 'free')
eq(getRateLimitPerMinute('builder'), 20, 'builder')
eq(getRateLimitPerMinute('pro'), 40, 'pro')
eq(getRateLimitPerMinute('starter'), 20, 'legacy starter → builder rate (20)')
eq(getRateLimitPerMinute('scale'), 40, 'legacy scale → pro rate (40)')
eq(getRateLimitPerMinute('nonsense'), 10, 'unknown → free rate (10)')

console.log('\n── getCaptureQuota ──')
eq(getCaptureQuota('free'), 250, 'free')
eq(getCaptureQuota('builder'), 1500, 'builder')
eq(getCaptureQuota('pro'), 7500, 'pro')
eq(getCaptureQuota('starter'), 1500, 'legacy starter → builder captures')
eq(getCaptureQuota('scale'), 7500, 'legacy scale → pro captures')
eq(getCaptureQuota('business'), 250, 'business → free captures (no invented limit)')

console.log('\n── getAiExtractionQuota ──')
eq(getAiExtractionQuota('free'), 25, 'free')
eq(getAiExtractionQuota('builder'), 150, 'builder')
eq(getAiExtractionQuota('pro'), 1000, 'pro')
eq(getAiExtractionQuota('starter'), 150, 'legacy starter → builder AI')
eq(getAiExtractionQuota('scale'), 1000, 'legacy scale → pro AI')
eq(getAiExtractionQuota('business'), 25, 'business → free AI (no invented limit)')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
