"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";
import Link from "next/link";

export default function AdmissionsPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-secondary-600 to-secondary-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>Admissions 🎓</h1>
          <p className="text-green-100 text-lg max-w-2xl mx-auto">Join our community of learners. Follow these simple steps to apply.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-extrabold text-slate-800 mb-3" style={{ fontFamily: "'Fredoka', sans-serif" }}>Admission Process</h2>
          </div>
          <div className="grid md:grid-cols-4 gap-6">
            {[
              { step: "1", icon: "📝", title: "Apply Online", desc: "Fill out our online application form with your child's details and upload required documents." },
              { step: "2", icon: "📋", title: "Assessment", desc: "Applicants may undergo an age-appropriate entrance assessment or interview." },
              { step: "3", icon: "✅", title: "Acceptance", desc: "Successful applicants receive an offer letter with enrollment details." },
              { step: "4", icon: "🎉", title: "Enrollment", desc: "Complete enrollment by paying fees and submitting final documents. Welcome aboard!" },
            ].map((s) => (
              <div key={s.step} className="relative p-6 rounded-3xl bg-white shadow-lg border border-slate-100 text-center hover:-translate-y-1 transition-all">
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 w-8 h-8 rounded-full gradient-secondary text-white flex items-center justify-center font-bold text-sm">{s.step}</div>
                <div className="text-4xl mb-3 mt-2">{s.icon}</div>
                <h3 className="font-bold text-lg text-slate-800 mb-2">{s.title}</h3>
                <p className="text-slate-500 text-sm">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-extrabold text-slate-800 mb-8 text-center" style={{ fontFamily: "'Fredoka', sans-serif" }}>Requirements 📋</h2>
          <div className="grid md:grid-cols-2 gap-8 max-w-4xl mx-auto">
            <div className="p-6 rounded-3xl bg-white shadow-lg border border-slate-100">
              <h3 className="font-bold text-lg text-slate-800 mb-4">Required Documents</h3>
              <ul className="space-y-2">
                {["Birth certificate", "Passport photographs (4)", "Previous school report (if applicable)", "Immunization records", "Parent/Guardian ID"].map((doc) => (
                  <li key={doc} className="flex items-center gap-2 text-sm text-slate-600">
                    <span className="text-secondary-500">✓</span> {doc}
                  </li>
                ))}
              </ul>
            </div>
            <div className="p-6 rounded-3xl bg-white shadow-lg border border-slate-100">
              <h3 className="font-bold text-lg text-slate-800 mb-4">Fee Structure</h3>
              <div className="space-y-3">
                {[
                  { level: "Nursery", fee: "Contact for pricing" },
                  { level: "Kindergarten", fee: "Contact for pricing" },
                  { level: "Primary", fee: "Contact for pricing" },
                  { level: "Junior High", fee: "Contact for pricing" },
                ].map((f) => (
                  <div key={f.level} className="flex justify-between items-center p-3 rounded-xl bg-slate-50">
                    <span className="font-medium text-sm text-slate-700">{f.level}</span>
                    <span className="text-sm text-primary-600 font-semibold">{f.fee}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-3xl mx-auto px-4 text-center">
          <div className="p-8 rounded-3xl gradient-secondary text-white">
            <h2 className="text-2xl font-bold mb-4">Ready to Apply?</h2>
            <p className="text-green-100 mb-6">Start your child&apos;s journey at CBISM today.</p>
            <Link href="/contact" className="inline-block px-8 py-4 rounded-2xl bg-white text-secondary-700 font-bold shadow-lg hover:scale-105 transition-all">
              Contact Admissions Office
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
