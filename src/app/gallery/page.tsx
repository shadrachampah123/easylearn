"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";
import { useState } from "react";

const categories = ["All", "Classroom", "Sports", "Events", "Arts", "Graduation"];

const galleryImages = [
  { id: 1, cat: "Classroom", emoji: "📚", title: "Interactive Learning", color: "from-blue-400 to-blue-600" },
  { id: 2, cat: "Sports", emoji: "⚽", title: "Sports Day 2024", color: "from-green-400 to-green-600" },
  { id: 3, cat: "Events", emoji: "🎉", title: "Cultural Festival", color: "from-purple-400 to-purple-600" },
  { id: 4, cat: "Arts", emoji: "🎨", title: "Art Exhibition", color: "from-pink-400 to-pink-600" },
  { id: 5, cat: "Graduation", emoji: "🎓", title: "KG Graduation", color: "from-yellow-400 to-yellow-600" },
  { id: 6, cat: "Classroom", emoji: "🔬", title: "Science Lab", color: "from-teal-400 to-teal-600" },
  { id: 7, cat: "Sports", emoji: "🏀", title: "Basketball Tournament", color: "from-orange-400 to-orange-600" },
  { id: 8, cat: "Events", emoji: "🎵", title: "Music Concert", color: "from-indigo-400 to-indigo-600" },
  { id: 9, cat: "Arts", emoji: "✏️", title: "Drawing Competition", color: "from-red-400 to-red-600" },
  { id: 10, cat: "Classroom", emoji: "💻", title: "Computer Lab", color: "from-cyan-400 to-cyan-600" },
  { id: 11, cat: "Graduation", emoji: "🏆", title: "Awards Ceremony", color: "from-amber-400 to-amber-600" },
  { id: 12, cat: "Events", emoji: "📖", title: "Reading Week", color: "from-emerald-400 to-emerald-600" },
];

export default function GalleryPage() {
  const [active, setActive] = useState("All");
  const filtered = active === "All" ? galleryImages : galleryImages.filter((g) => g.cat === active);

  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-lavender to-purple-800 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>Gallery 📸</h1>
          <p className="text-purple-100 text-lg max-w-2xl mx-auto">Explore our vibrant school life through photos and memories.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap justify-center gap-2 mb-10">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setActive(cat)}
                className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${
                  active === cat
                    ? "gradient-primary text-white shadow-lg"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filtered.map((img) => (
              <div
                key={img.id}
                className={`aspect-square rounded-3xl bg-gradient-to-br ${img.color} flex flex-col items-center justify-center text-white shadow-lg hover:scale-105 hover:shadow-xl transition-all cursor-pointer`}
              >
                <div className="text-5xl mb-2">{img.emoji}</div>
                <p className="font-semibold text-sm text-center px-4">{img.title}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
