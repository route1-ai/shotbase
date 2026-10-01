# Overnight Open-Source Prep Log

## Task 1 — docker-compose.yml + .env.example
Created `docker-compose.yml` (shotbase + redis:7-alpine services, port 3000:8080, named redis_data volume).
Rewrote `.env.example` with two sections: self-host required vars and hosted-only vars (all placeholders).
`docker compose config` validated clean. `npm run build` passed.
Note: `package.json` has `"private": true` — kept (it is the backend service, not an npm-published lib). Added `"license": "AGPL-3.0-only"` alongside it.
## Task 4 — CONTRIBUTING.md + SECURITY.md
Created CONTRIBUTING.md (~45 lines): local setup, dev server, Redis, test invocation, commit convention, PR guidelines.
Created SECURITY.md (~20 lines): private disclosure email, self-host responsibility note, supported versions.
## Task 3 — README
Restructured README with two-way split (self-host vs hosted), self-host quickstart, full API field table, license section, contributing pointer.
## Task 2 — LICENSE
Fetched verbatim AGPL-3.0 text from gnu.org (661 lines). Added copyright header to src/server.ts (3 lines). Set license field in package.json. `private: true` retained — backend service is not published to npm.
