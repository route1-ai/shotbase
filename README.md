# Shotbase

**The AI-native screenshot API for agents.** One call returns the rendered image **and**
structured intelligence about the page — page type, headings, CTAs, prices — so your agent
sees the page the way a person does, not just a blob of pixels.

## Install as an MCP server (one line)

Shotbase is a native [MCP](https://modelcontextprotocol.io) tool. Add it to Claude Code,
Claude Desktop, Cursor, or any MCP client:

```bash
claude mcp add shotbase \
  --transport http \
  --header "Authorization: Bearer sk_your_shotbase_key" \
  https://api.shotbase.dev/api/mcp
```

Then:

1. **Get your key** → https://shotbase.dev/dashboard/keys
2. **Run the command above** (paste your key in place of `sk_your_shotbase_key`)
3. **Ask your agent** → *"Screenshot stripe.com/pricing and tell me the tiers."*

Your agent now has one tool, `shotbase_capture`, that returns the screenshot **and** the
extracted JSON in a single call.

## The tool

`shotbase_capture`

| Argument | Type | Default | Description |
|---|---|---|---|
| `url` | string | — | Page to capture (required) |
| `extract` | boolean | `true` | Return structured intelligence alongside the image |
| `format` | string | `png` | `png` · `jpeg` · `webp` · `pdf` |
| `full_page` | boolean | `false` | Capture the full scrollable page |
| `viewport` | object | `1440×900` | `{ "width": number, "height": number }` |

The result contains an image block plus, when `extract` is on, the structured intelligence
as JSON.

## Direct HTTP API

Prefer raw HTTP? Same engine, no MCP client needed:

```bash
curl -X POST https://api.shotbase.dev/screenshot \
  -H "Authorization: Bearer sk_your_shotbase_key" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://stripe.com/pricing", "ai_extract": { "page_type": true, "headings": true, "prices": true } }'
```

Health check: `GET https://api.shotbase.dev/health`
