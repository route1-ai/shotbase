# Security model

A screenshot API is a server that fetches arbitrary URLs on a caller's behalf.
That makes it a server-side request forgery (SSRF) engine by default: the most
valuable target is not the public internet, it is the private network the server
itself sits in. Everything below exists because of that.

This document describes what the code does. For reporting a vulnerability, see
[SECURITY.md](../SECURITY.md).

---

## 1. Request forgery (SSRF)

Every capture URL is validated before a browser is involved — no page is loaded
until it passes.

**Scheme allowlist.** `http` and `https` only. `file://`, `gopher://`, `data:`,
`ftp://` and everything else are rejected.

**Embedded credentials rejected.** `https://user:pass@host/` is refused rather
than quietly forwarded to the target.

**Private and reserved address space blocked.** Rejected ranges:

| Range | Why |
|---|---|
| `127.0.0.0/8`, `0.0.0.0/8` | loopback / this-host |
| `10/8`, `172.16/12`, `192.168/16` | RFC 1918 private |
| `169.254.0.0/16` | link-local — **this is the cloud instance metadata endpoint** |
| `100.64/10` | carrier NAT |
| `224.0.0.0/4` and above | multicast / reserved |
| `::1`, `::`, `fc00::/7`, `fe80::/10` | IPv6 loopback, unique-local, link-local |

The `169.254.169.254` case is the one that matters most: on AWS, GCP and Azure
that address serves the instance's own IAM credentials to anything that asks.
An unguarded screenshot API hands an attacker the server's cloud role.

**IPv4-mapped IPv6 normalised.** `::ffff:10.0.0.1` is unwrapped and the embedded
IPv4 address is checked, so the mapping cannot be used to smuggle a private
address past the filter.

**Malformed addresses fail closed.** An address that cannot be parsed is treated
as private and rejected, rather than passed through.

**DNS rebinding defended.** A hostname is resolved and **every** returned address
is checked, not just the first. A public hostname whose DNS record points into
private space is rejected on the resolved address.

**Internal hostnames blocked.** `localhost`, `*.localhost`, `*.local`,
`*.internal`, `*.cluster.local`.

**The guard is in the backend, not the frontend.** Direct API callers and MCP
clients never touch the web proxy, so validation lives on the path every caller
shares. A client-side-only guard would be no guard at all.

---

## 2. Authentication

**Fails closed.** With no key-management service configured, there is no bypass
path — requests are rejected rather than defaulting to allow. Self-hosted
deployments authenticate against an explicit `API_KEYS` list; there are no
built-in, default, or hardcoded keys at any point.

**Bearer only.** A missing or malformed `Authorization` header is a `401` before
any work is scheduled.

**Trust is not inferred from headers.** A caller-supplied user-identity header is
honoured only for an internally authenticated proxy, never for an ordinary API
key. A key holder cannot assert someone else's identity.

---

## 3. Multi-tenant isolation

The render cache is keyed on the URL and render options only — deliberately
caller-agnostic, so two callers requesting the same public page share a cached
render.

That is safe only if authenticated renders are never cached, so any capture
carrying per-viewer material for the target page — cookies, custom request
headers, a target `Authorization` — bypasses the cache on **both read and write**
and renders fresh. Without that rule, one tenant's logged-in page could be served
to the next caller of the same URL.

---

## 4. Resource exhaustion

**Browser concurrency gate.** A fixed number of concurrent Chromium contexts
(`MAX_BROWSER_CONCURRENCY`, default 4) with a bounded queue
(`MAX_BROWSER_QUEUE`, default 20) and a queue timeout
(`BROWSER_QUEUE_TIMEOUT_MS`, default 10s). Past capacity, callers get `503` with
`Retry-After` instead of the process dying under load.

**Request body limit.** `MAX_BODY_BYTES`, default 1 MiB, with `413` past it.

**Per-key rate limiting.** Enforced before any browser work is scheduled, so a
rejected caller costs no render capacity.

**Bounded inputs.** URL max 2048 characters; `device_scale_factor` 1–3; viewport
dimensions range-checked; format restricted to an enum; `ai_extract` capped in
field count. All validated before a browser is touched.

**AI call timeout.** Model requests abort at 30s so a hung provider cannot hold a
browser permit open indefinitely.

---

## 5. Information disclosure

**Render errors are classified, not echoed.** Navigation failures map to a fixed
set of codes (`dns_failed`, `ssl_error`, `connection_refused`,
`navigation_timeout`, `render_failed`). The raw error, stack traces and internal
file paths stay server-side. Covered by 35 assertions in
`test/error-mapping.mjs`, including an explicit check that no stack or path
leaks to the caller.

**A blocked private IP is distinguishable from a DNS failure.** `blocked_url`
versus `dns_failed`. They are kept distinct deliberately: collapsing them would
make the guard's behaviour ambiguous to an operator debugging a legitimate block.

**Model provider errors are never echoed.** AI failures return a fixed
`"AI extraction temporarily unavailable"` string. Provider error bodies are not
logged, because some providers echo the submitted request — including the API
key — back in an error response.

**Usage accounting fails closed.** If the accounting store cannot be read, the
response is `503`. A usage number is never fabricated or assumed to be zero.

---

## 6. Secrets handling

All credentials come from the environment. None are committed, and none have
defaults.

`.dockerignore` excludes `.env` from the build context, so credentials cannot be
baked into an image layer and later recovered by anyone who pulls it.

Service-role and provider credentials are server-side only and are never exposed
to a browser context.

---

## 7. Graceful degradation

A capture does not fail because an optional dependency did. Redis absent → an
in-memory cache. Usage store absent → quota disabled. Model provider absent,
misconfigured, or erroring → HTTP 200 with the screenshot and page text intact,
`ai_data: null`, and a generic `ai_error`.

This is a security property, not just a convenience: a degraded dependency that
turned into a 500 would leak which dependency failed, and would push operators
toward disabling the guards to get a working response.

Verified in `test/extraction-degrade.mjs` (14 assertions), including that no
provider internals appear in the degraded response and that MCP degrades the
same way.

---

## 8. Self-hosted: what is yours to own

Self-hosting moves the trust boundary to you.

- **Authentication is an `API_KEYS` list you manage.** No rotation UI, no
  per-key scoping, no revocation beyond editing the list and restarting. If you
  need managed keys, use the hosted service.
- **Put TLS in front of it.** The container speaks plain HTTP. Terminate TLS at
  nginx, Caddy, or your load balancer.
- **Do not expose it to the public internet with a shared key.** Anyone holding
  that key can make your server fetch URLs.
- **Capturing your own internal hosts is not currently possible.** The SSRF guard
  blocks private address space with no opt-out. An explicit per-host allowlist is
  tracked as an open issue; a blanket "allow private" switch is deliberately
  **not** offered, because an instance reachable by any key holder would expose
  the cloud metadata endpoint.
- **Keep it updated.** Chromium is the attack surface; a stale image is a stale
  browser.

---

## Honest limits

- **No third-party security audit or penetration test has been performed.**
- The guards above are enforced by unit and integration tests, not by a formal
  review.
- AGPL-3.0 means you can read every line and verify these claims yourself.
  Please do — and open an issue if something here does not match the code.
