# @shotbase/mcp

The [Shotbase](https://shotbase.dev) MCP server — capture any web page **and** get structured intelligence (page type, headings, CTAs, prices) in **one call**, straight from your agent.

This is a tiny, zero-dependency bridge: it connects your MCP client over stdio and forwards to Shotbase's hosted MCP endpoint, authenticating with your API key from an environment variable. Because it forwards `tools/list` to the live server, the tool schema is always current — nothing to update here.

## Get an API key
Create one at **https://shotbase.dev/dashboard** (keys look like `sk_…`). The same key works for the REST API.

## Use it

Most clients need only this — no manual header flags:

```jsonc
{
  "mcpServers": {
    "shotbase": {
      "command": "npx",
      "args": ["-y", "@shotbase/mcp"],
      "env": { "SHOTBASE_API_KEY": "YOUR_KEY" }
    }
  }
}
```

- **Claude Desktop** → `claude_desktop_config.json`
- **Cursor** → `.cursor/mcp.json`
- **Zed** → `settings.json` under `context_servers`

You can also pass the key as an argument instead of the env var: `"args": ["-y", "@shotbase/mcp", "--key", "YOUR_KEY"]`.

## The tool

`shotbase_capture`

| arg | type | required | default |
|---|---|---|---|
| `url` | string | ✅ | — |
| `extract` | boolean | | `true` (return the structured intelligence too) |
| `format` | `png` \| `jpeg` \| `webp` \| `pdf` | | `png` |
| `full_page` | boolean | | `false` |
| `viewport` | `{ width, height }` | | `1440 × 900` |

Returns the rendered image plus, when `extract` is on, the extracted JSON.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `SHOTBASE_API_KEY` | — | **Required** (or `--key`). Your Shotbase key. |
| `SHOTBASE_MCP_URL` | `https://api.shotbase.dev/api/mcp` | Override the endpoint (self-host / staging). |

Requires Node 18+ (uses the built-in `fetch`).
