"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";
import { useState } from "react";

const faqData = [
  { q: "What are the school hours?", a: "School runs from 7:30 AM to 2:30 PM, Monday to Friday. After-school activities run until 4:00 PM." },
  { q: "What is the admission process?", a: "Visit our admissions page, fill out the online application form, submit required documents, complete the assessment, and receive your offer letter." },
  { q: "Do you offer school transportation?", a: "Yes, CBISM provides school bus services for various routes within the city. Contact the office for available routes and fees." },
  { q: "What extracurricular activities do you offer?", a: "We offer sports (football, basketball, athletics), music, drama, debate, coding club, art club, reading club, science club, and more!" },
  { q: "How can I monitor my child's progress?", a: "Parents can log in to the EasyLearn platform to view grades, attendance, assignments, and communicate directly with teachers." },
  { q: "What is the student-to-teacher ratio?", a: "We maintain a low ratio of approximately 20:1 for primary classes and 15:1 for nursery and kindergarten." },
  { q: "Do you provide meals?", a: "Yes, we offer a nutritious lunch program. Parents can also send packed meals. All meals are supervised." },
  { q: "What curriculum do you follow?", a: "We follow the Ghana Education Service curriculum enhanced with international best practices and the Montessori method for early years." },
  { q: "How do I reset my EasyLearn password?", a: "Click 'Forgot Password' on the login page, enter your email, and follow the instructions sent to your inbox." },
  { q: "Can learners access EasyLearn from home?", a: "Absolutely! EasyLearn is accessible from any device with an internet connection - phones, tablets, and computers." },
];

function FAQItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-slate-200 rounded-2xl overflow-hidden hover:shadow-md transition-all">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-slate-50 transition-colors"
      >
        <span className="font-semibold text-slate-700 pr-4">{q}</span>
        <span className={`text-xl transition-transform ${open ? "rotate-45" : ""}`}>+</span>
      </button>
      {open && (
        <div className="px-5 pb-5 text-slate-500 text-sm leading-relaxed animate-fade-in">{a}</div>
      )}
    </div>
  );
}

export default function FAQPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-mint to-emerald-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>FAQ ❓</h1>
          <p className="text-emerald-100 text-lg max-w-2xl mx-auto">Find answers to commonly asked questions.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-3">
          {faqData.map((item, i) => (
            <FAQItem key={i} q={item.q} a={item.a} />
          ))}
        </div>
      </section>

      <Footer />
    </div>
  );
}
