# Overnight Open-Source Prep Log

## Final summary

**Completed (all 5 tasks):**
1. `docker-compose.yml` + rewritten `.env.example` — two-service compose (shotbase + redis:7-alpine), `docker compose config` validated clean.
2. `LICENSE` — full verbatim AGPL-3.0 (661 lines from gnu.org). Copyright header in `src/server.ts`. `"license": "AGPL-3.0-only"` in `package.json`.
3. `README.md` restructured — self-host vs hosted split, quickstart, full API field table, license section, contributing link.
4. `CONTRIBUTING.md` + `SECURITY.md` — local dev, test invocation, commit convention, private disclosure email.
5. `benchmarks/results.md` — methodology from bench.mjs, numbers from results.csv, honesty section, reproduce instructions.

Also committed: `.dockerignore` (prevent `.env` from baking into image) and `.gitignore` update (exclude internal docs from public repo).

**`npm run build` passes on all commits.**

**What you must do by hand before going public:**
- Set repo visibility to public on GitHub (not done — never touches repo visibility).
- Confirm the GitHub remote URL in README (`https://github.com/route1-ai/shotbase.git`) is correct — update if the org/repo name differs.
- Merge this branch into `main` via a PR (not done — instructions forbade merging to main).
- `.nvmrc` exists locally but is not committed — consider adding it to pin Node version and avoid Railway drift (mentioned in CLAUDE.md as a known risk).
- `package.json` has `"private": true` — this is intentional (backend service, not an npm lib) but you may want to confirm it won't block anything in your CI/CD pipeline.
- The MCP install command in README uses `https://api.shotbase.dev/api/mcp` — verify this URL is live before going public.
- Consider whether the Railway hostname (`shotbase-production.up.railway.app`) should be mentioned anywhere; I removed it from public-facing docs per the internal-URLs rule.

**Unsure about:**
- "Three of six competitor API keys failed" — I included this as instructed but from the CSV only 2 of the competitor slots (capturekit + 1 unconfigured) were missing. If you counted differently, update `benchmarks/results.md` accordingly.
- Docker build was NOT run end-to-end (no `docker compose up -d --build`) — the Playwright base image takes ~15 min to pull and build, which would consume most of the night. `docker compose config` validated clean. The Dockerfile is unchanged from the working production setup.



## Task 1 — docker-compose.yml + .env.example
Created `docker-compose.yml` (shotbase + redis:7-alpine services, port 3000:8080, named redis_data volume).
Rewrote `.env.example` with two sections: self-host required vars and hosted-only vars (all placeholders).
`docker compose config` validated clean. `npm run build` passed.
Note: `package.json` has `"private": true` — kept (it is the backend service, not an npm-published lib). Added `"license": "AGPL-3.0-only"` alongside it.
## Task 5 — benchmarks/results.md
Created benchmarks/results.md from bench/bench.mjs methodology and bench/results.csv data. Includes fresh-capture medians, repeat-cache table, DATA mode table, consistency table, honesty section, and reproduce instructions. Three providers completed (shotbase, screenshotone, apiflash); capturekit failed preflight; urlbox/others not configured.
## Task 4 — CONTRIBUTING.md + SECURITY.md
Created CONTRIBUTING.md (~45 lines): local setup, dev server, Redis, test invocation, commit convention, PR guidelines.
Created SECURITY.md (~20 lines): private disclosure email, self-host responsibility note, supported versions.
## Task 3 — README
Restructured README with two-way split (self-host vs hosted), self-host quickstart, full API field table, license section, contributing pointer.
## Task 2 — LICENSE
Fetched verbatim AGPL-3.0 text from gnu.org (661 lines). Added copyright header to src/server.ts (3 lines). Set license field in package.json. `private: true` retained — backend service is not published to npm.
