"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";

const subjectsByLevel = {
  "Nursery & Kindergarten": [
    "Numeracy", "Literacy", "Creative Arts", "Physical Education", "Social Skills", "Sensorial Activities",
  ],
  "Primary (1-6)": [
    "English Language", "Mathematics", "Integrated Science", "Social Studies", "French",
    "ICT", "Creative Arts", "Religious & Moral Education", "Ghanaian Language", "Physical Education",
  ],
  "Junior High (1-3)": [
    "English Language", "Mathematics", "Integrated Science", "Social Studies", "French",
    "ICT", "Creative Arts", "Religious & Moral Education", "Pre-Technical Skills", "Physical Education",
  ],
};

export default function AcademicsPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-accent-500 to-accent-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>Academics 📚</h1>
          <p className="text-orange-100 text-lg max-w-2xl mx-auto">Our comprehensive curriculum designed for 21st-century learners.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="space-y-12">
            {Object.entries(subjectsByLevel).map(([level, subs]) => (
              <div key={level}>
                <h2 className="text-2xl font-bold text-slate-800 mb-6 flex items-center gap-2">
                  <span className="w-10 h-10 rounded-xl gradient-primary flex items-center justify-center text-white text-lg">📖</span>
                  {level}
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                  {subs.map((sub) => (
                    <div key={sub} className="p-4 rounded-2xl bg-white shadow-md border border-slate-100 hover:shadow-lg hover:-translate-y-0.5 transition-all text-center">
                      <p className="font-medium text-sm text-slate-700">{sub}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-extrabold text-slate-800 mb-8 text-center" style={{ fontFamily: "'Fredoka', sans-serif" }}>
            Extracurricular Activities 🎯
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { icon: "⚽", name: "Sports" },
              { icon: "🎵", name: "Music" },
              { icon: "🎭", name: "Drama" },
              { icon: "💬", name: "Debate" },
              { icon: "💻", name: "Coding Club" },
              { icon: "🎨", name: "Art Club" },
              { icon: "📖", name: "Reading Club" },
              { icon: "🧪", name: "Science Club" },
            ].map((a) => (
              <div key={a.name} className="p-6 rounded-3xl bg-white shadow-md text-center hover:shadow-lg hover:scale-105 transition-all border border-slate-100">
                <div className="text-4xl mb-2">{a.icon}</div>
                <p className="font-semibold text-sm text-slate-700">{a.name}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
