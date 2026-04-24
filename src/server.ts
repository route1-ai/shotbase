import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { chromium } from 'playwright'

const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok', service: 'shotbase' }))

app.post('/screenshot', async (c) => {
  const authorization = c.req.header('Authorization')
  if (!authorization) {
    return c.json({ error: 'Missing API key' }, 401)
  }

  const match = authorization.match(/^Bearer\s+(.+)$/)
  const apiKey = match?.[1]?.trim()
  if (!apiKey) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  const validKeys = (process.env.API_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  if (!validKeys.includes(apiKey)) {
    return c.json({ error: 'Invalid API key' }, 401)
  }

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }

  const url = (body as { url?: unknown } | null)?.url
  if (typeof url !== 'string' || url.trim().length === 0) {
    return c.json({ error: 'Missing url' }, 400)
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'platform', { get: () => 'MacIntel' })
    })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 })
    const png = await page.screenshot({ type: 'png', fullPage: false })
    const bytes = new Uint8Array(new ArrayBuffer(png.byteLength))
    bytes.set(png)
    return c.body(bytes, 200, { 'Content-Type': 'image/png' })
  } finally {
    await browser.close()
  }
})

const port = Number(process.env.PORT ?? 3000)
console.log(`Shotbase running on port ${port}`)

serve({ fetch: app.fetch, port })
