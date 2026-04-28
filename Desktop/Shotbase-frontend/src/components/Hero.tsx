"use client"
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'

const CURL_COMMAND = `curl -X POST https://api.shotbase.dev/v1/screenshot \\
  -H "Authorization: Bearer sf_live_xxx" \\
  -d '{"url":"https://stripe.com","format":"png"}'`

const words = ["Screenshot", "any", "URL.", "One", "API", "call."]

export default function Hero() {
  const [typed, setTyped] = useState('')
  const [showResult, setShowResult] = useState(false)

  useEffect(() => {
    let i = 0
    let timeout: NodeJS.Timeout
    const typeNext = () => {
      if (i < CURL_COMMAND.length) {
        setTyped(CURL_COMMAND.slice(0, i + 1))
        i++
        timeout = setTimeout(typeNext, Math.random() * 20 + 5)
      } else {
        setTimeout(() => setShowResult(true), 500)
      }
    }
    typeNext()
    return () => clearTimeout(timeout)
  }, [])

  return (
    <section style={{position: 'relative', width:'100%', paddingTop:'80px', paddingBottom:'20px', paddingLeft:'24px', paddingRight:'24px', background:'rgba(5,5,5,0.85)', backdropFilter:'blur(10px)'}}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundImage: 'linear-gradient(to right, rgba(255, 255, 255, 0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(255, 255, 255, 0.05) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
        maskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)',
        WebkitMaskImage: 'linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,0) 80%)',
        zIndex: 0
      }} />
      <div style={{position: 'relative', zIndex: 1, width:'100%', maxWidth:'1280px', margin:'0 auto', display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:'48px', alignItems:'center'}}>

        {/* Left */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="mono text-xs px-3 py-1.5 border inline-block mb-6"
            style={{ borderColor: 'var(--green)', color: 'var(--green)' }}
          >
            SCREENSHOT API
          </motion.div>

          <h1 className="text-5xl lg:text-6xl font-bold mb-6 leading-tight" style={{ color: 'var(--heading)' }}>
            {words.map((word, i) => (
              <motion.span
                key={i}
                initial={{ opacity: 0, y: 40 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: i * 0.1 }}
                className="inline-block mr-4"
                style={word === 'URL.' || word === 'call.' ? { color: 'var(--green)' } : {}}
              >
                {word}
              </motion.span>
            ))}
          </h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.8 }}
            className="text-lg mb-8"
            style={{ color: 'var(--dim)' }}
          >
            200 free screenshots/month. No credit card. Ships in 2 minutes.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 1 }}
            className="flex gap-4 mb-6"
          >
            <a href="https://shotbase.dev/signup" className="px-6 py-3 font-semibold text-black transition-all hover:brightness-110 inline-block"
                    style={{ background: 'var(--green)' }}>
              Get Free API Key
            </a>
            <a href="https://docs.shotbase.dev" className="px-6 py-3 text-sm transition-colors hover:text-[var(--green)] inline-block"
                    style={{ color: 'var(--dim)' }}>
              View Docs →
            </a>
          </motion.div>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.2 }}
            className="mono text-xs"
            style={{ color: 'var(--dim)' }}
          >
            ✓ 99.9% uptime · &lt;800ms avg · ✓ No charge for failures
          </motion.p>
        </div>

        {/* Terminal */}
        <motion.div
          initial={{ opacity: 0, x: 40 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="rounded-lg overflow-hidden border"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          <div className="flex items-center gap-2 px-4 py-3 border-b" style={{ borderColor: 'var(--border)', background: '#111118' }}>
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="mono text-xs ml-2" style={{ color: 'var(--dim)' }}>terminal</span>
          </div>
          <div className="p-5">
            <p className="mono text-xs mb-3" style={{ color: 'var(--dim)' }}># Take a screenshot of any URL</p>
            <pre className="mono text-xs leading-relaxed whitespace-pre-wrap" style={{ color: 'var(--green)' }}>
              {typed}<span className="animate-pulse">▋</span>
            </pre>
            {showResult && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-4 pt-4 border-t mono text-xs"
                style={{ borderColor: 'var(--border)', color: 'var(--green)' }}
              >
                ✓ 847ms · PNG · 2.4MB · X-Cache: MISS
              </motion.div>
            )}
          </div>
        </motion.div>
      </div>
    </section>
  )
}
