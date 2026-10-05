#!/usr/bin/env node
// @shotbase/mcp — a thin stdio↔HTTP bridge to the hosted Shotbase MCP server.
//
// It forwards every JSON-RPC message verbatim to POST <SHOTBASE_MCP_URL>, injecting the
// API key as an Authorization header. Because it forwards `tools/list` (and everything
// else) to the live server, the tool schema is NEVER hardcoded here — this package needs
// no release when the tool changes. Zero runtime dependencies (Node built-ins only).
//
// Why this exists: stdio-only clients (Claude Desktop, Zed) can't send a custom
// Authorization header for a remote HTTP MCP server, and the generic `mcp-remote --header`
// bridge is fragile (its header flag splits on spaces). Here the key comes from an env
// var, so `npx -y shotbase-mcp` is one clean, unbreakable line.
//
// Config: SHOTBASE_API_KEY (required; or --key <key>). SHOTBASE_MCP_URL optional
// (default https://api.shotbase.dev/api/mcp).

import readline from 'node:readline'

const DEFAULT_URL = 'https://api.shotbase.dev/api/mcp'
const url = process.env.SHOTBASE_MCP_URL || DEFAULT_URL

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : ''
}
const key = process.env.SHOTBASE_API_KEY || argValue('--key')
if (!key) {
  process.stderr.write('shotbase-mcp: missing API key. Set SHOTBASE_API_KEY (or pass --key <key>).\n')
  process.exit(1)
}
if (typeof fetch !== 'function') {
  process.stderr.write('shotbase-mcp: this Node is too old (needs global fetch — Node 18+).\n')
  process.exit(1)
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let inFlight = 0
let stdinClosed = false
const maybeExit = () => { if (stdinClosed && inFlight === 0) process.exit(0) }

// MCP stdio framing: one complete JSON-RPC message per line, no embedded newlines.
rl.on('line', async (line) => {
  const text = line.trim()
  if (!text) return
  let id = null
  try { const m = JSON.parse(text); id = m && Object.prototype.hasOwnProperty.call(m, 'id') ? m.id : null } catch { /* forward as-is */ }
  inFlight++
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${key}` },
      body: text,
      signal: AbortSignal.timeout(120000), // never hang forever on a stuck request
    })
    // Notifications get 202 with no body → nothing to write back to the client.
    if (res.status === 202) return
    const body = await res.text()
    if (!body) return
    process.stdout.write(body.endsWith('\n') ? body : body + '\n')
  } catch (err) {
    // Only a request (has an id) expects a response; a notification stays silent.
    if (id !== null && id !== undefined) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `shotbase-mcp bridge error: ${err?.message || String(err)}` } }) + '\n')
    }
  } finally {
    inFlight--
    maybeExit() // if stdin already closed, exit once the last in-flight request drains
  }
})
// Don't exit the instant stdin closes — a response may still be in flight (esp. when
// input is piped rather than an interactive client). Drain first, then exit.
rl.on('close', () => { stdinClosed = true; maybeExit() })
