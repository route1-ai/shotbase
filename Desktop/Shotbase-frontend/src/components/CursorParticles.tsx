"use client"
import { useEffect, useRef } from 'react'
import { gsap } from 'gsap'

interface Mouse { x:number; y:number; smoothX:number; smoothY:number; diff:number }

class Particle {
  size:number; x:number; y:number; color:string; el:SVGCircleElement
  constructor(x:number, y:number, size:number, particles:Particle[], svg:SVGSVGElement) {
    this.size=size; this.x=x; this.y=y; this.color='#00e87b'
    this.el=document.createElementNS('http://www.w3.org/2000/svg','circle')
    this.el.setAttribute('cx',x.toString())
    this.el.setAttribute('cy',y.toString())
    this.el.setAttribute('r',size.toString())
    this.el.setAttribute('fill',this.color)
    this.el.setAttribute('opacity','0.8')
    svg.appendChild(this.el)
    const tl=gsap.timeline()
    tl.to(this,{size:size*2,ease:'power1.inOut',duration:0.5})
    tl.to(this,{size:0,ease:'power4.in',duration:1},0.8)
    tl.to(this.el,{opacity:0,duration:1},0.8)
    tl.call(()=>this.kill(particles))
  }
  kill(particles:Particle[]) {
    const i=particles.indexOf(this)
    if(i>-1) particles.splice(i,1)
    this.el.remove()
  }
  render() {
    this.el.setAttribute('cx',this.x.toString())
    this.el.setAttribute('cy',this.y.toString())
    this.el.setAttribute('r',this.size.toString())
  }
}

export default function CursorParticles() {
  const svgRef=useRef<SVGSVGElement>(null)
  const mouseRef=useRef<Mouse>({x:0,y:0,smoothX:0,smoothY:0,diff:0})
  const particlesRef=useRef<Particle[]>([])
  const rafRef=useRef<number | null>(null)
  const frameRef=useRef(0)

  useEffect(()=>{
    const mouse=mouseRef.current
    const particles=particlesRef.current
    const svg=svgRef.current
    if(!svg) return

    const onMove=(e:MouseEvent)=>{ mouse.x=e.clientX; mouse.y=e.clientY }

    const loop=()=>{
      if(particles.length>30){
        rafRef.current=requestAnimationFrame(loop)
        return
      }
      mouse.smoothX+=(mouse.x-mouse.smoothX)*0.1
      mouse.smoothY+=(mouse.y-mouse.smoothY)*0.1
      mouse.diff=Math.hypot(mouse.x-mouse.smoothX,mouse.y-mouse.smoothY)
      frameRef.current++
      if(mouse.diff>2 && frameRef.current%3===0){
        const p=new Particle(mouse.smoothX,mouse.smoothY,mouse.diff*0.15,particles,svg)
        particles.push(p)
      }
      particles.forEach(p=>p.render())
      rafRef.current=requestAnimationFrame(loop)
    }

    window.addEventListener('mousemove',onMove)
    loop()
    return ()=>{
      window.removeEventListener('mousemove',onMove)
      if(rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  },[])

  return (
    <svg
      ref={svgRef}
      style={{position:'fixed',top:0,left:0,width:'100%',height:'100%',pointerEvents:'none',zIndex:9999}}
    />
  )
}
