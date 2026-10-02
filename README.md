# Shotbase

**The AI-native screenshot API for agents.** One call returns the rendered image **and**
structured intelligence about the page — page type, headings, CTAs, prices — so your agent
sees the page the way a person does, not just a blob of pixels.

---

## Two ways to run it

| | Self-host | Hosted (shotbase.dev) |
|---|---|---|
| **Cost** | Free | Paid plans |
| **License** | AGPL-3.0 | Commercial |
| **Setup** | `docker compose up` | Get a key, one `claude mcp add` |
| **Accounts / billing** | None | Included |
| **Ops** | You run it | Managed |

Self-host: clone the repo, set `API_KEYS`, done. You own the instance entirely.  
Hosted: get a key at [shotbase.dev](https://shotbase.dev/dashboard/keys), one-line MCP install below.

---

## Self-host quickstart

```bash
git clone https://github.com/route1-ai/shotbase.git
cd shotbase
cp .env.example .env
# Edit .env — set API_KEYS to any string you want, e.g.:
#   API_KEYS=sk_mysecretkey
docker compose up
```

Then verify it is running:

```bash
curl http://localhost:3000/health
```

Take a screenshot:

```bash
curl -X POST http://localhost:3000/screenshot \
  -H "Authorization: Bearer sk_mysecretkey" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com", "format": "png" }'
```

**What self-hosting does NOT include:**

- No user accounts or API key dashboard
- No billing or usage quotas
- No usage dashboard
- AI extraction (`ai_extract`) needs your own model provider — see below. Screenshots
  work without it; `ai_extract` requests return 400 with an explanation.

### AI extraction on your own key

`ai_extract` works with any OpenAI-compatible `/chat/completions` endpoint. Set three
values in `.env`:

```bash
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=your_key
AI_MODEL=openai/gpt-oss-120b
```

Verified working: **Groq**, **OpenAI** (`https://api.openai.com/v1`), **OpenRouter**
(`https://openrouter.ai/api/v1`), **DeepSeek**, **Together**. AWS Bedrock is also
supported via `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`.

**Fully local, nothing leaves your machine** — point it at Ollama:

```bash
AI_BASE_URL=http://host.docker.internal:11434/v1
AI_MODEL=llama3.2
# no AI_API_KEY needed
```

Reasoning models (gpt-oss, qwen3) bill their thinking against the reply budget. If
extraction returns empty, raise `AI_MAX_TOKENS` (default 4096).

For the full field reference, see [The API](#the-api) below.

---

## Hosted — install as an MCP server (one line)

Shotbase is a native [MCP](https://modelcontextprotocol.io) tool. Add it to Claude Code,
Claude Desktop, Cursor, or any MCP client:

```bash
claude mcp add --transport http shotbase https://api.shotbase.dev/api/mcp \
  --header "Authorization: Bearer sk_your_shotbase_key"
```

> The server URL must come right after the name; `--header` goes last (it's variadic).

1. **Get your key** → https://shotbase.dev/dashboard/keys
2. **Run the command above** (paste your key in place of `sk_your_shotbase_key`)
3. **Ask your agent** → *"Screenshot stripe.com/pricing and tell me the tiers."*

Your agent now has one tool, `shotbase_capture`, that returns the screenshot **and** the
extracted JSON in a single call.

---

## The API

### `POST /screenshot`

| Field | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | Page to capture (required) |
| `format` | string | `png` | `png` · `jpeg` · `webp` · `pdf` |
| `full_page` | boolean | `false` | Capture the full scrollable page |
| `width` | integer | `1440` | Viewport width (100–3840) |
| `height` | integer | `900` | Viewport height (100–2160) |
| `include_text` | boolean | `false` | Include extracted page text in the response |
| `ai_extract` | object | — | Request structured intelligence (requires Bedrock) |
| `wait_until` | string | — | `load` · `domcontentloaded` · `networkidle` · `commit` |
| `delay_ms` | integer | `0` | Extra wait after load (0–10000 ms) |
| `block_ads` | boolean | `false` | Block ad networks |
| `remove_popups` | boolean | `false` | Attempt to dismiss cookie/newsletter overlays |
| `dark_mode` | boolean | `false` | Emulate prefers-color-scheme: dark |
| `device_scale_factor` | number | `1` | Pixel density (1–3) |

### `GET /health`

Returns `{ "status": "ok", "service": "shotbase" }` with HTTP 200, or `"degraded"` with
HTTP 503 when the browser pool is unhealthy. Useful as a container healthcheck.

### MCP tool — `shotbase_capture`

| Argument | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | Page to capture (required) |
| `extract` | boolean | `true` | Return structured intelligence alongside the image |
| `format` | string | `png` | `png` · `jpeg` · `webp` · `pdf` |
| `full_page` | boolean | `false` | Capture the full scrollable page |
| `viewport` | object | `1440×900` | `{ "width": number, "height": number }` |

---

## License

Shotbase is [AGPL-3.0](LICENSE). You can self-host and modify it freely. If you offer a
modified version to others over a network, you must publish your source changes under the
same license. For a commercial license without the copyleft obligation, contact the author.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local dev setup, test instructions, and PR guidelines.
