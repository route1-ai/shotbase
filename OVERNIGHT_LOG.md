# Overnight Open-Source Prep Log

## Task 1 — docker-compose.yml + .env.example
Created `docker-compose.yml` (shotbase + redis:7-alpine services, port 3000:8080, named redis_data volume).
Rewrote `.env.example` with two sections: self-host required vars and hosted-only vars (all placeholders).
`docker compose config` validated clean. `npm run build` passed.
Note: `package.json` has `"private": true` — see Task 2 note.
