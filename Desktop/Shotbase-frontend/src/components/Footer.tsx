export default function Footer() {
  return (
    <footer className="w-full py-12 px-6 border-t" style={{ position: 'relative', zIndex: 10, borderColor: 'var(--border)', background:'rgba(5,5,5,0.95)' }}>
      <div className="w-full max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
        <span className="mono text-xs" style={{ color: 'var(--dim)' }}>
          © 2026 Shotbase · A Route1AI product
        </span>
        <div className="flex gap-6">
          <a href="https://docs.shotbase.dev" className="mono text-xs transition-colors hover:text-[var(--green)]" style={{ color: 'var(--dim)' }}>Docs</a>
          <a href="https://status.shotbase.dev" className="mono text-xs transition-colors hover:text-[var(--green)]" style={{ color: 'var(--dim)' }}>Status</a>
          <a href="https://github.com/shotbase" className="mono text-xs transition-colors hover:text-[var(--green)]" style={{ color: 'var(--dim)' }}>GitHub</a>
          <a href="https://twitter.com/shotbase" className="mono text-xs transition-colors hover:text-[var(--green)]" style={{ color: 'var(--dim)' }}>Twitter</a>
        </div>
      </div>
    </footer>
  )
}
