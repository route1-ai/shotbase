"use client"
import { motion, useInView } from 'framer-motion'
import { useRef } from 'react'

const features = [
  { title: "AI Popup Removal", desc: "GPT-4o detects and removes cookie banners before capture. No competitor does this.", icon: "🤖" },
  { title: "Sub-200ms Cache", desc: "Same URL twice? Second call instant. Cached requests never count against quota.", icon: "⚡" },
  { title: "MCP Server", desc: "Native tool for Claude Desktop, Cursor, Windsurf. AI agents get screenshots natively.", icon: "🔌" },
  { title: "Zero Failed Charges", desc: "Site down? Timeout? We don't charge. Period.", icon: "🛡" },
  { title: "500/Month Free", desc: "Enough to build and test. No credit card required.", icon: "🎁" },
  { title: "JS + Python + Go", desc: "Published on npm, PyPI, pkg.go.dev. Each SDK is a distribution channel.", icon: "📦" },
]

export default function Features() {
  const ref = useRef(null)
  const isInView = useInView(ref, { once: true, margin: '-100px' })

  return (
    <section ref={ref} style={{width:'100%', padding:'80px 24px', background:'rgba(5,5,5,0.85)', backdropFilter:'blur(10px)'}}>
      <div style={{width:'100%', maxWidth:'1280px', margin:'0 auto'}}>
        <motion.p
          initial={{ opacity: 0 }}
          animate={isInView ? { opacity: 1 } : {}}
          className="mono text-xs mb-12 text-center"
          style={{ color: 'var(--green)' }}
        >
          [ WHY SHOTBASE ]
        </motion.p>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {features.map((f, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 40 }}
              animate={isInView ? { opacity: 1, y: 0 } : {}}
              transition={{ duration: 0.5, delay: i * 0.1 }}
              className="p-6 rounded-lg border transition-all hover:border-green-400 h-full flex flex-col"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <div className="text-2xl mb-4">{f.icon}</div>
              <h3 className="font-bold mb-2" style={{ color: 'var(--heading)' }}>{f.title}</h3>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--dim)' }}>{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
