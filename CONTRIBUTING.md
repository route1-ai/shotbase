# Contributing

## Local dev setup (no Docker required)

```bash
git clone https://github.com/route1-ai/shotbase.git
cd shotbase
npm install
cp .env.example .env
# Edit .env — set API_KEYS to any string, e.g. API_KEYS=dev_key
# Leave Unkey/Supabase/Bedrock vars blank for local dev
```

Start the dev server (hot-reloads via tsx):

```bash
npm run dev
```

The server listens on port 3000 by default (set `PORT` in `.env` to change it).
Health check: `curl http://localhost:3000/health`

You will also need a running Redis instance. The fastest way:

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

Then set `REDIS_URL=redis://localhost:6379` in `.env`.

## Running the tests

```bash
npm run smoke        # MCP bridge smoke test (starts server, runs mcp-smoke.mjs)
```

Individual test scripts in `test/` can be run directly with Node once the server is up:

```bash
node test/validation-smoke.mjs
node test/error-mapping.mjs
```

PRs that change capture or auth behavior should include a test in `test/`.

## Commit convention

Follow the pattern in this repo's git history — conventional commits with a scope:

```
feat(scope): short description
fix(scope): short description
chore: short description
docs: short description
test(scope): short description
perf(scope): short description
```

Keep the subject line under 72 characters. Body is optional but welcome for
non-obvious changes.

## Pull requests

- Open against `main`.
- Describe what changed and why.
- If you change capture or auth behavior, include a test.
- One concern per PR.
