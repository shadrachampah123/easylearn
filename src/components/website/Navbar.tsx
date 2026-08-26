"use client";

import { useState } from "react";
import Link from "next/link";

const navLinks = [
  { name: "Home", href: "/" },
  { name: "About", href: "/about" },
  { name: "Admissions", href: "/admissions" },
  { name: "Academics", href: "/academics" },
  { name: "Gallery", href: "/gallery" },
  { name: "News", href: "/news" },
  { name: "Contact", href: "/contact" },
  { name: "FAQ", href: "/faq" },
];

export default function Navbar() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 glass shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2 group">
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-2xl gradient-primary flex items-center justify-center text-white font-bold text-lg md:text-xl shadow-lg group-hover:scale-105 transition-transform">
              EL
            </div>
            <div className="hidden sm:block">
              <p className="font-bold text-primary-700 text-sm md:text-base leading-tight">EasyLearn</p>
              <p className="text-[10px] md:text-xs text-slate-500 leading-tight">CBISM</p>
            </div>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden lg:flex items-center gap-1">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                className="px-3 py-2 rounded-xl text-sm font-medium text-slate-600 hover:text-primary-600 hover:bg-primary-50 transition-all"
              >
                {link.name}
              </Link>
            ))}
          </div>

          {/* Auth Buttons */}
          <div className="hidden md:flex items-center gap-2">
            <Link
              href="/login"
              className="px-5 py-2.5 text-sm font-semibold text-primary-600 hover:bg-primary-50 rounded-xl transition-all"
            >
              Log In
            </Link>
            <Link
              href="/register"
              className="px-5 py-2.5 text-sm font-semibold text-white gradient-primary rounded-xl shadow-lg hover:shadow-xl hover:scale-105 transition-all"
            >
              Register
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="lg:hidden p-2 rounded-xl hover:bg-slate-100 transition-colors"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {isOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {isOpen && (
        <div className="lg:hidden glass border-t border-white/30 animate-slide-up">
          <div className="px-4 py-3 space-y-1">
            {navLinks.map((link) => (
              <Link
                key={link.name}
                href={link.href}
                onClick={() => setIsOpen(false)}
                className="block px-4 py-3 rounded-xl text-sm font-medium text-slate-600 hover:text-primary-600 hover:bg-primary-50 transition-all"
              >
                {link.name}
              </Link>
            ))}
            <div className="flex gap-2 pt-3 border-t border-slate-200">
              <Link
                href="/login"
                className="flex-1 text-center px-4 py-3 text-sm font-semibold text-primary-600 border border-primary-200 rounded-xl"
              >
                Log In
              </Link>
              <Link
                href="/register"
                className="flex-1 text-center px-4 py-3 text-sm font-semibold text-white gradient-primary rounded-xl"
              >
                Register
              </Link>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}
