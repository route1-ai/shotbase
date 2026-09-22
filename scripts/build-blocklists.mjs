// Regenerate the bundled filter-engine snapshots loaded at startup (offline-safe).
// Run manually when refreshing lists: `node scripts/build-blocklists.mjs`.
// Produces lists/ads-and-tracking.bin (ghostery prebuilt ads+tracking) and
// lists/popups.bin (EasyList Cookie List + Fanboy's Annoyance List).
import { PlaywrightBlocker } from '@ghostery/adblocker-playwright'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lists')
const POPUP_LISTS = [
  'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt', // EasyList Cookie List
  'https://secure.fanboy.co.nz/fanboy-annoyance.txt',     // Fanboy's Annoyance List
]
const ads = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch)
writeFileSync(join(OUT, 'ads-and-tracking.bin'), Buffer.from(ads.serialize()))
const popups = await PlaywrightBlocker.fromLists(fetch, POPUP_LISTS)
writeFileSync(join(OUT, 'popups.bin'), Buffer.from(popups.serialize()))
console.log('wrote lists/ads-and-tracking.bin and lists/popups.bin')
