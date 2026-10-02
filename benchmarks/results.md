# Shotbase Competitor Benchmark — Results

Run date: 2026-09-23. Single run from a single geographic origin.

---

## Methodology

The harness (`bench/bench.mjs`) measured end-to-end latency from **request sent to last
byte of the response body** — not any provider-reported render time.

**What was tested:**

- 3 runs × 4 target pages (interleaved within each run so network drift hits everyone equally)
- 60-second timeout per call; a non-image response is counted as a failure
- Cache-bust query parameter per run so providers cannot serve a pre-warmed result
- REPEAT mode: same URL requested twice; the second request is timed (shows whose cache helps)
- DATA mode (Shotbase only): `include_text + ai_extract` — not a comparison, competitors
  do not offer structured intelligence extraction

**Target pages:** example.com (static), stripe.com (marketing), news.ycombinator.com
(text-heavy), linear.app (JS app)

**Providers attempted:** shotbase, screenshotone, apiflash, capturekit, urlbox.
Three providers completed the run (shotbase, screenshotone, apiflash). capturekit
returned 403 Forbidden on preflight and was excluded. urlbox was not configured — no
key was supplied, so it was skipped rather than tested. The comparison therefore covers
three providers, not the field.

---

## Fresh-capture median latency (ms) — request → last byte

3 runs per target. All three providers returned images on every call they attempted.

| Target | shotbase | screenshotone | apiflash |
|---|---|---|---|
| example.com (static) | 1641 | 2742 | **1368** |
| stripe.com (marketing) | **3791** | 5036 | 8123 |
| news.ycombinator.com (text) | **1553** | 3119 | 2159 |
| linear.app (JS app) | **3864** | 4214 | 10916 |

Shotbase was fastest on 3 of 4 targets. apiflash was fastest on the static page (example.com
is ~4 KB of HTML; latency there reflects network round-trip more than render time).

**Important caveat:** the margins were not reproducible across runs. screenshotone's
marketing spread was 4308–10632ms (2.5× range). Shotbase's static spread was
1453–2406ms (1.66× range). With n=3 runs from a single origin, raw speed margins
are not defensible claims. The reproducible finding is **consistency** — see below.

---

## Repeat (cached) latency — 2nd call on same URL (ms)

Shotbase caches renders for 60 seconds by default. Competitors were called with
`cache=false` / `fresh=true` per their APIs, so their repeat call is a fresh render by
design. This is not a fair apples-to-apples comparison — it documents Shotbase's cache
behaviour, not a competitor weakness.

| Target | shotbase (2nd) | screenshotone (2nd) | apiflash (2nd) |
|---|---|---|---|
| example.com (static) | 492 | 2480 | 1613 |
| stripe.com (marketing) | 866 | 4103 | 7976 |
| news.ycombinator.com (text) | 836 | 3022 | 1999 |
| linear.app (JS app) | 886 | 6975 | 10244 |

---

## DATA mode — Shotbase only (image + structured intelligence)

`include_text + ai_extract` (page_type, headings, ctas, prices via AWS Bedrock).
Competitors do not offer this. 3 runs; text and jsapp hit the free-plan rate limit on
run 3 (429), so those show 2/3 successful calls.

| Target | median ms | successful runs |
|---|---|---|
| example.com (static) | 2535 | 3/3 |
| stripe.com (marketing) | 8602 | 3/3 |
| news.ycombinator.com (text) | ~2590 (avg of 2) | 2/3 |
| linear.app (JS app) | ~6304 (avg of 2) | 2/3 |

Most of the DATA-mode latency on complex pages is Bedrock (AI extraction): marketing page
showed ~4800ms Bedrock time out of ~8600ms total.

---

## Consistency

Within-run fastest↔slowest spread for fresh calls (lower ratio = more consistent):

| Provider | static | marketing | text | jsapp |
|---|---|---|---|---|
| shotbase | 1453–2406ms (1.66×) | 3503–3921ms (1.12×) | 1385–1693ms (1.22×) | 3790–4628ms (1.22×) |
| screenshotone | 2562–3311ms (1.29×) | 4308–10632ms (2.47×) | 2975–3168ms (1.06×) | 3914–4405ms (1.12×) |
| apiflash | 1281–1403ms (1.09×) | 7894–8489ms (1.08×) | 2114–2185ms (1.03×) | 10422–10921ms (1.05×) |

apiflash is the most consistent (low jitter). Shotbase is consistent on most targets;
static page showed the highest spread (auth + quota overhead dominates on fast pages).
screenshotone had a single very slow marketing run (10 632ms) in an otherwise 4–5 s band.

---

## Honesty section

**What this benchmark cannot claim:**

- **Raw speed rankings are not stable.** With 3 runs from one machine in one location,
  a margin of a few hundred milliseconds is within network noise. Do not cite these
  numbers as definitive speed claims.
- **Most of the field is missing.** Only two competitors were actually measured.
  capturekit returned 403 and was excluded; urlbox was never configured. This is a
  three-provider snapshot, not a market comparison.
- **Cold vs. warm cache not isolated.** The Shotbase instance was running and had
  served prior requests before this benchmark; we did not instrument cache state
  per provider.
- **Single geographic origin.** Results from a different region will differ,
  especially for providers with regional PoPs.
- **Small sample.** n=3 per target is enough to observe a trend, not to establish
  statistical significance.

**What is defensible:** Shotbase returned a correct image on every attempted call.
Shotbase's cache (60s) dramatically reduces repeat-request latency. The DATA mode
(image + AI extraction in one call) has no direct competitor equivalent tested here.

---

## Reproduce this yourself

You need your own API keys for each service you want to include. Create
`bench/bench.env.json` (gitignored) with the following shape — supply only the keys
you have; providers with a blank or missing key are skipped automatically:

```json
{
  "SHOTBASE": "your_shotbase_key",
  "SCREENSHOTONE": "your_screenshotone_access_key",
  "APIFLASH": "your_apiflash_access_key",
  "CAPTUREKIT": "your_capturekit_access_key",
  "URLBOX_SECRET": "your_urlbox_secret"
}
```

Then:

```bash
node bench/bench.mjs
```

Results are written to `bench/results-<timestamp>.csv`. The file is gitignored.
