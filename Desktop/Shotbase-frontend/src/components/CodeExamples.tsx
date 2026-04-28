"use client"
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'

const examples = {
  cURL: `curl -X POST https://api.shotbase.dev/v1/screenshot \\
  -H "Authorization: Bearer YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"url":"https://stripe.com","format":"png"}' \\
  --output screenshot.png`,
  JavaScript: `const res = await fetch('https://api.shotbase.dev/v1/screenshot', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer YOUR_KEY' },
  body: JSON.stringify({
    url: 'https://stripe.com',
    format: 'png',
    ai_extract: { prices: true, ctas: true }
  })
})
const image = await res.blob()`,
  Python: `import httpx

r = httpx.post(
  'https://api.shotbase.dev/v1/screenshot',
  headers={'Authorization': 'Bearer YOUR_KEY'},
  json={'url': 'https://stripe.com', 'format': 'png'}
)
open('screenshot.png', 'wb').write(r.content)`
}

export default function CodeExamples() {
  const [active, setActive] = useState('cURL')

  return (
    <section style={{width:'100%', padding:'80px 24px', background:'rgba(5,5,5,0.85)', backdropFilter:'blur(10px)'}}>
      <div style={{width:'100%', maxWidth:'900px', margin:'0 auto'}}>
        <p className="mono text-xs mb-4 text-center" style={{ color: 'var(--green)' }}>[ CODE EXAMPLES ]</p>
        <h2 className="text-3xl font-bold text-center mb-12" style={{ color: 'var(--heading)' }}>
          Drop in. No config.
        </h2>
        <div className="flex gap-2 mb-4">
          {Object.keys(examples).map(tab => (
            <button
              key={tab}
              onClick={() => setActive(tab)}
              className="mono text-xs px-4 py-2 border transition-all"
              style={{
                borderColor: active === tab ? 'var(--green)' : 'var(--border)',
                color: active === tab ? 'var(--green)' : 'var(--dim)',
                background: active === tab ? 'rgba(0,232,123,0.05)' : 'transparent'
              }}
            >
              {tab}
            </button>
          ))}
        </div>
        <AnimatePresence mode="wait">
          <motion.pre
            key={active}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="mono text-xs p-6 rounded-lg border overflow-x-auto leading-relaxed"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border)',
              color: 'var(--green)'
            }}
          >
            {examples[active as keyof typeof examples]}
          </motion.pre>
        </AnimatePresence>
      </div>
    </section>
  )
}
