"use client";

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

          {/* Native mobile disclosure: opens without waiting for React hydration. */}
          <details className="relative z-[60] lg:hidden">
            <summary
              aria-label="Toggle navigation menu"
              aria-controls="mobile-navigation-menu"
              className="relative z-[60] flex min-h-12 min-w-12 cursor-pointer touch-manipulation select-none list-none items-center justify-center rounded-xl p-3 text-slate-900 hover:bg-slate-100 [&::-webkit-details-marker]:hidden"
            >
              <svg
                aria-hidden="true"
                className="pointer-events-none h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </summary>

            <div
              id="mobile-navigation-menu"
              className="absolute right-0 top-full z-[60] mt-2 w-[min(20rem,calc(100vw-2rem))] glass rounded-2xl border border-white/30 p-2 shadow-xl"
            >
              <div className="space-y-1">
                {navLinks.map((link) => (
                  <Link
                    key={link.name}
                    href={link.href}
                    className="block min-h-11 rounded-xl px-4 py-3 text-sm font-medium text-slate-700 hover:bg-primary-50 hover:text-primary-600"
                  >
                    {link.name}
                  </Link>
                ))}
                <div className="flex gap-2 border-t border-slate-200 pt-3">
                  <Link
                    href="/login"
                    className="min-h-11 flex-1 rounded-xl border border-primary-200 px-4 py-3 text-center text-sm font-semibold text-primary-600"
                  >
                    Log In
                  </Link>
                  <Link
                    href="/register"
                    className="min-h-11 flex-1 rounded-xl gradient-primary px-4 py-3 text-center text-sm font-semibold text-white"
                  >
                    Register
                  </Link>
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>
    </nav>
  );
}
