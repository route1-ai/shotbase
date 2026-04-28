import Nav from '@/components/Nav'
import Hero from '@/components/Hero'
import Features from '@/components/Features'
import CodeExamples from '@/components/CodeExamples'
import Pricing from '@/components/Pricing'
import Footer from '@/components/Footer'
import { WebGLShader } from '@/components/WebGLShader'

export default function Home() {
  return (
    <div style={{position:'relative',zIndex:1}}>
      <WebGLShader />
      <Nav />
      <Hero />
      <Features />
      <CodeExamples />
      <Pricing />
      <Footer />
    </div>
  )
}
