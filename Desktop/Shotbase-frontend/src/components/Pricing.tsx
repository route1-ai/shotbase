"use client"
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'

const plans = [
  { name: 'FREE', price: '$0', period: '/mo', limit: '100 screenshots/mo', features: ['PNG JPEG WebP PDF', 'AI popup removal', 'Playground access', 'Watermark on output'], cta: 'Get started →', highlight: false },
  { name: 'STARTER', price: '$9', period: '/mo', limit: '3,000 screenshots/mo', features: ['No watermark', 'AI content extraction', 'Caching (TTL config)', 'JS + Python SDKs'], cta: 'Start free trial →', highlight: false },
  { name: 'PRO', price: '$19', period: '/mo', limit: '10,000 screenshots/mo', features: ['Everything in Starter', 'Webhooks + async mode', 'MCP server access', 'Priority queue', 'Slack support'], cta: 'Start free trial →', highlight: true },
  { name: 'SCALE', price: '$49', period: '/mo', limit: '50,000 screenshots/mo', features: ['Everything in Pro', 'Dedicated workers', 'Custom S3/R2 bucket', 'SLA guarantee'], cta: 'Contact us →', highlight: false },
]

export default function Pricing() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <section ref={ref} id="pricing" style={{width:'100%', padding:'80px 24px', background:'rgba(5,5,5,0.85)', backdropFilter:'blur(10px)'}}>
      <div style={{width:'100%', maxWidth:'1280px', margin:'0 auto'}}>
        <p className="mono text-xs mb-4 text-center" style={{ color: 'var(--green)' }}>[ PRICING ]</p>
        <h2 className="text-3xl font-bold text-center mb-4" style={{ color: 'var(--heading)' }}>
          Pay for what you use.
        </h2>
        <p className="text-center mb-16" style={{ color: 'var(--dim)' }}>
          Start free. No credit card. Upgrade when ready.
        </p>
        <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:'16px'}}>
          {plans.map((plan, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 40 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              whileHover={{ y: -4, boxShadow: '0 0 30px rgba(0,232,123,0.2)' }}
              className="p-6 rounded-lg border relative"
              style={{
                background: 'var(--surface)',
                borderColor: plan.highlight ? 'var(--green)' : 'var(--border)',
              }}
            >
              {plan.highlight && (
                <div className="absolute -top-3 right-4 mono text-xs px-2 py-1 font-bold text-black"
                     style={{ background: 'var(--green)' }}>
                  MOST POPULAR
                </div>
              )}
              <p className="mono text-xs mb-3" style={{ color: 'var(--dim)' }}>{plan.name}</p>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-3xl font-bold" style={{ color: 'var(--heading)' }}>{plan.price}</span>
                <span className="mono text-xs" style={{ color: 'var(--dim)' }}>{plan.period}</span>
              </div>
              <p className="mono text-xs mb-6" style={{ color: 'var(--green)' }}>{plan.limit}</p>
              <ul className="space-y-2 mb-8">
                {plan.features.map((f, j) => (
                  <li key={j} className="text-sm flex items-start gap-2" style={{ color: 'var(--dim)' }}>
                    <span style={{ color: 'var(--green)' }}>✓</span> {f}
                  </li>
                ))}
              </ul>
              <a
                href={plan.highlight ? "https://shotbase.dev/signup?plan=pro" : "https://shotbase.dev/signup"}
                className="w-full py-2 mono text-xs border transition-all inline-block text-center hover:brightness-110"
                style={{
                  background: plan.highlight ? 'var(--green)' : 'transparent',
                  color: plan.highlight ? '#000' : 'var(--dim)',
                  borderColor: plan.highlight ? 'var(--green)' : 'var(--border)',
                }}
              >
                {plan.cta}
              </a>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
