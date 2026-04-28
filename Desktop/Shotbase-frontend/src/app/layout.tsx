import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Shotbase — Screenshot API for Developers',
  description: 'Screenshot any URL. One API call. 500 free per month.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ isolation: 'isolate' }}>{children}</body>
    </html>
  )
}
