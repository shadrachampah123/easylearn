"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";
import { useState } from "react";

export default function ContactPage() {
  const [sent, setSent] = useState(false);

  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-coral to-pink-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>Contact Us 📞</h1>
          <p className="text-pink-100 text-lg max-w-2xl mx-auto">We&apos;d love to hear from you. Reach out to us anytime.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-12">
            {/* Contact Form */}
            <div>
              <h2 className="text-2xl font-bold text-slate-800 mb-6">Send us a Message</h2>
              {sent ? (
                <div className="p-8 rounded-3xl bg-green-50 border border-green-200 text-center">
                  <div className="text-5xl mb-3">✅</div>
                  <h3 className="font-bold text-lg text-green-700 mb-2">Message Sent!</h3>
                  <p className="text-green-600 text-sm">We&apos;ll get back to you as soon as possible.</p>
                </div>
              ) : (
                <form
                  onSubmit={(e) => { e.preventDefault(); setSent(true); }}
                  className="space-y-4"
                >
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                      <input type="text" required className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm" />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                      <input type="text" required className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                    <input type="email" required className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                    <input type="tel" className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
                    <select className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm">
                      <option>General Inquiry</option>
                      <option>Admissions</option>
                      <option>Fees</option>
                      <option>Academic</option>
                      <option>Technical Support</option>
                      <option>Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Message</label>
                    <textarea required rows={4} className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm resize-none" />
                  </div>
                  <button type="submit" className="w-full py-3 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all">
                    Send Message 📨
                  </button>
                </form>
              )}
            </div>

            {/* Info */}
            <div className="space-y-6">
              <h2 className="text-2xl font-bold text-slate-800 mb-6">Contact Information</h2>
              {[
                { icon: "📍", title: "Address", info: "123 Education Avenue, Accra, Ghana" },
                { icon: "📞", title: "Phone", info: "+233 (0) 30 123 4567" },
                { icon: "✉️", title: "Email", info: "info@cbism.edu" },
                { icon: "🕐", title: "Office Hours", info: "Mon - Fri: 7:30 AM - 4:00 PM" },
                { icon: "🌐", title: "Website", info: "www.cbism.edu" },
              ].map((c) => (
                <div key={c.title} className="flex items-start gap-4 p-4 rounded-2xl bg-white shadow-sm border border-slate-100">
                  <div className="text-2xl">{c.icon}</div>
                  <div>
                    <p className="font-semibold text-slate-700">{c.title}</p>
                    <p className="text-sm text-slate-500">{c.info}</p>
                  </div>
                </div>
              ))}

              <div className="rounded-3xl overflow-hidden shadow-lg h-64">
                <iframe
                  src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d254424.75424677!2d-0.2714!3d5.6037!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0xfdf9084b2b7a773%3A0xbed14ed8650e2dd3!2sAccra%2C+Ghana!5e0!3m2!1sen!2s!4v1"
                  width="100%" height="100%" style={{ border: 0 }}
                  allowFullScreen loading="lazy" title="Map"
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
