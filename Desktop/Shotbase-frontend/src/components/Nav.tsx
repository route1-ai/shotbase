"use client";

import React, { useRef, useState } from "react";
import { motion } from "framer-motion";

export default function Nav() {
  const [position, setPosition] = useState({
    left: 0,
    width: 0,
    opacity: 0,
  });

  return (
    <nav style={{
      position: 'fixed',
      top: 0,
      left: 0,
      width: '100%',
      zIndex: 1000,
      background: 'rgba(5,5,5,0.95)',
      borderBottom: '1px solid #1a1a24',
      backdropFilter: 'blur(12px)'
    }}>
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Logo */}
        <a href="/" className="mono font-bold text-lg" style={{ color: 'var(--green)' }}>
          Shotbase
        </a>

        {/* Nav Links with animated cursor */}
        <ul
          className="relative flex gap-1"
          onMouseLeave={() => setPosition((pv) => ({ ...pv, opacity: 0 }))}
        >
          <Tab setPosition={setPosition} href="/">Home</Tab>
          <Tab setPosition={setPosition} href="#pricing">Pricing</Tab>
          <Tab setPosition={setPosition} href="#docs">Docs</Tab>

          <Cursor position={position} />
        </ul>

        {/* Auth buttons */}
        <div className="flex items-center gap-4">
          <a href="https://shotbase.dev/login" className="text-sm transition-colors hover:text-white" style={{ color: 'var(--dim)' }}>
            Sign In
          </a>
          <a href="https://shotbase.dev/signup"
             className="px-4 py-2 text-sm font-semibold text-black transition-all hover:brightness-110"
             style={{ background: 'var(--green)' }}>
            Get API Key
          </a>
        </div>
      </div>
    </nav>
  );
}

const Tab = ({
  children,
  setPosition,
  href,
}: {
  children: React.ReactNode;
  setPosition: any;
  href: string;
}) => {
  const ref = useRef<HTMLLIElement>(null);
  return (
    <li
      ref={ref}
      onMouseEnter={() => {
        if (!ref.current) return;

        const { width } = ref.current.getBoundingClientRect();
        setPosition({
          width,
          opacity: 1,
          left: ref.current.offsetLeft,
        });
      }}
      className="relative z-10 block cursor-pointer px-4 py-2 text-sm text-[var(--dim)] hover:text-white transition-colors mono"
    >
      <a href={href} className="block">{children}</a>
    </li>
  );
};

const Cursor = ({ position }: { position: any }) => {
  return (
    <motion.li
      animate={position}
      className="absolute z-0 h-8 rounded-full bg-white/10 top-0.5"
    />
  );
};
