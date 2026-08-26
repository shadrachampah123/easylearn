"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";

export default function AboutPage() {
  return (
    <div className="min-h-screen">
      <Navbar />

      {/* Hero */}
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-primary-600 to-primary-900 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>
            About CBISM 🏫
          </h1>
          <p className="text-blue-100 text-lg max-w-2xl mx-auto">
            Learn about our history, vision, mission, and the values that drive us.
          </p>
        </div>
      </section>

      {/* History */}
      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-extrabold text-slate-800 mb-6" style={{ fontFamily: "'Fredoka', sans-serif" }}>
                Our History 📜
              </h2>
              <p className="text-slate-600 leading-relaxed mb-4">
                City Best International School Montessori (CBISM) was established with a vision to provide quality, 
                affordable, and inclusive education. Starting with just a handful of nursery students, we have grown 
                into a full-fledged institution serving learners from Nursery through Junior High School.
              </p>
              <p className="text-slate-600 leading-relaxed mb-4">
                Over the years, CBISM has consistently produced outstanding students who have excelled in various 
                fields. Our Montessori-inspired approach, combined with modern technology and dedicated educators, 
                makes us one of the most innovative schools in the region.
              </p>
              <p className="text-slate-600 leading-relaxed">
                Today, with the launch of EasyLearn, we continue our tradition of innovation by embracing digital 
                learning tools that empower our learners, teachers, and parents.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              {["📚 2009\nFounded", "🎓 2012\nFirst Graduation", "🏆 2018\nBest School Award", "💻 2024\nEasyLearn Launch"].map((item, i) => (
                <div key={i} className="p-6 rounded-3xl bg-gradient-to-br from-primary-50 to-secondary-50 text-center shadow-sm">
                  <p className="text-sm font-semibold text-slate-700 whitespace-pre-line">{item}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Vision, Mission, Values */}
      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-3 gap-8">
            <div className="p-8 rounded-3xl bg-white shadow-lg border border-slate-100">
              <div className="w-16 h-16 rounded-2xl bg-blue-100 flex items-center justify-center text-3xl mb-4">🎯</div>
              <h3 className="text-xl font-bold text-slate-800 mb-3">Our Vision</h3>
              <p className="text-slate-600 leading-relaxed">
                To be the leading international school that nurtures globally competitive, morally upright, 
                and innovative learners who contribute positively to society.
              </p>
            </div>
            <div className="p-8 rounded-3xl bg-white shadow-lg border border-slate-100">
              <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center text-3xl mb-4">🌟</div>
              <h3 className="text-xl font-bold text-slate-800 mb-3">Our Mission</h3>
              <p className="text-slate-600 leading-relaxed">
                To provide holistic education through the Montessori approach, modern technology, and 
                skilled educators that empowers every learner to reach their full potential.
              </p>
            </div>
            <div className="p-8 rounded-3xl bg-white shadow-lg border border-slate-100">
              <div className="w-16 h-16 rounded-2xl bg-orange-100 flex items-center justify-center text-3xl mb-4">💎</div>
              <h3 className="text-xl font-bold text-slate-800 mb-3">Core Values</h3>
              <ul className="text-slate-600 space-y-2">
                {["Excellence", "Integrity", "Innovation", "Compassion", "Discipline", "Diversity"].map((v) => (
                  <li key={v} className="flex items-center gap-2 text-sm">
                    <span className="w-2 h-2 rounded-full bg-primary-400" />
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* School Anthem */}
      <section className="py-16 md:py-24">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-extrabold text-slate-800 mb-6" style={{ fontFamily: "'Fredoka', sans-serif" }}>
            School Anthem 🎵
          </h2>
          <div className="p-8 rounded-3xl bg-gradient-to-br from-primary-50 to-secondary-50 border border-primary-100">
            <p className="text-slate-700 leading-loose italic text-lg">
              🎶 City Best, City Best, where we learn and do our best,<br />
              Knowledge grows, friendship flows, reaching high where excellence goes.<br />
              Hand in hand, we proudly stand, building futures for our land,<br />
              With courage, love, and truth we shine—CBISM, forever mine! 🎶
            </p>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
