"use client";

import Link from "next/link";

const footerLinks = {
  school: [
    { name: "About Us", href: "/about" },
    { name: "Admissions", href: "/admissions" },
    { name: "Academics", href: "/academics" },
    { name: "Gallery", href: "/gallery" },
    { name: "News & Events", href: "/news" },
  ],
  resources: [
    { name: "FAQ", href: "/faq" },
    { name: "Downloads", href: "/downloads" },
    { name: "Contact Us", href: "/contact" },
    { name: "Parent Portal", href: "/login" },
    { name: "Student Portal", href: "/login" },
  ],
  legal: [
    { name: "Privacy Policy", href: "#" },
    { name: "Terms of Service", href: "#" },
    { name: "Cookie Policy", href: "#" },
  ],
};

export default function Footer() {
  return (
    <footer className="bg-slate-900 text-white">
      {/* Main Footer */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="lg:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-12 h-12 rounded-2xl gradient-primary flex items-center justify-center text-white font-bold text-xl shadow-lg">
                EL
              </div>
              <div>
                <p className="font-bold text-lg">EasyLearn</p>
                <p className="text-xs text-slate-400">CBISM</p>
              </div>
            </div>
            <p className="text-slate-400 text-sm leading-relaxed mb-4">
              City Best International School Montessori - Nurturing young minds, building bright futures through innovative education.
            </p>
            {/* Social Media */}
            <div className="flex gap-3">
              {["Facebook", "Twitter", "Instagram", "YouTube"].map((social) => (
                <a
                  key={social}
                  href="#"
                  className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-primary-600 flex items-center justify-center transition-colors"
                  aria-label={social}
                >
                  <span className="text-xs font-bold">{social[0]}</span>
                </a>
              ))}
            </div>
          </div>

          {/* School Links */}
          <div>
            <h3 className="font-semibold text-sm uppercase tracking-wider text-slate-300 mb-4">School</h3>
            <ul className="space-y-2">
              {footerLinks.school.map((link) => (
                <li key={link.name}>
                  <Link href={link.href} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources Links */}
          <div>
            <h3 className="font-semibold text-sm uppercase tracking-wider text-slate-300 mb-4">Resources</h3>
            <ul className="space-y-2">
              {footerLinks.resources.map((link) => (
                <li key={link.name}>
                  <Link href={link.href} className="text-slate-400 hover:text-white text-sm transition-colors">
                    {link.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact Info */}
          <div>
            <h3 className="font-semibold text-sm uppercase tracking-wider text-slate-300 mb-4">Contact</h3>
            <div className="space-y-3 text-sm text-slate-400">
              <p className="flex items-start gap-2">
                <span className="text-lg">📍</span>
                <span>123 Education Avenue,<br />Accra, Ghana</span>
              </p>
              <p className="flex items-center gap-2">
                <span className="text-lg">📞</span>
                <span>+233 (0) 30 123 4567</span>
              </p>
              <p className="flex items-center gap-2">
                <span className="text-lg">✉️</span>
                <span>info@cbism.edu</span>
              </p>
              <p className="flex items-center gap-2">
                <span className="text-lg">🕐</span>
                <span>Mon - Fri: 7:30 AM - 2:30 PM</span>
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="border-t border-slate-800">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex flex-col md:flex-row items-center justify-between gap-2">
          <p className="text-slate-500 text-xs">
            © {new Date().getFullYear()} City Best International School Montessori. All rights reserved.
          </p>
          <p className="text-slate-500 text-xs">
            Powered by <span className="text-primary-400 font-semibold">EasyLearn (EL)</span>
          </p>
        </div>
      </div>
    </footer>
  );
}
