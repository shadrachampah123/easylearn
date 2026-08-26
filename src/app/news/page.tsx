"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";

const newsItems = [
  {
    id: 1, title: "CBISM Wins Best School Award 2024", date: "Oct 15, 2024",
    excerpt: "We are proud to announce that CBISM has been recognized as the Best International School for innovative education methods.",
    tag: "Achievement", emoji: "🏆", color: "bg-yellow-100 text-yellow-700",
  },
  {
    id: 2, title: "EasyLearn Platform Launch", date: "Sep 1, 2024",
    excerpt: "Our new digital learning platform is now live! Teachers, learners, and parents can access all learning resources online.",
    tag: "Technology", emoji: "💻", color: "bg-blue-100 text-blue-700",
  },
  {
    id: 3, title: "Annual Sports Day Coming Soon", date: "Nov 5, 2024",
    excerpt: "Get ready for our biggest sports event of the year! Track and field, football, basketball, and more.",
    tag: "Event", emoji: "⚽", color: "bg-green-100 text-green-700",
  },
  {
    id: 4, title: "Science Fair Winners Announced", date: "Oct 8, 2024",
    excerpt: "Congratulations to our JHS students who showcased amazing science projects at the annual science fair.",
    tag: "Academic", emoji: "🔬", color: "bg-purple-100 text-purple-700",
  },
  {
    id: 5, title: "Parent-Teacher Conference", date: "Oct 20, 2024",
    excerpt: "Join us for the first parent-teacher conference of the academic year. Discuss your child's progress.",
    tag: "Event", emoji: "🤝", color: "bg-orange-100 text-orange-700",
  },
  {
    id: 6, title: "New Computer Lab Opening", date: "Sep 15, 2024",
    excerpt: "We've upgraded our ICT facilities with brand new computers and software for our coding program.",
    tag: "Facility", emoji: "🖥️", color: "bg-cyan-100 text-cyan-700",
  },
];

export default function NewsPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-sky to-blue-700 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>News & Events 📰</h1>
          <p className="text-blue-100 text-lg max-w-2xl mx-auto">Stay updated with the latest happenings at CBISM.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {newsItems.map((item) => (
              <article key={item.id} className="p-6 rounded-3xl bg-white shadow-lg border border-slate-100 hover:shadow-xl hover:-translate-y-1 transition-all group">
                <div className="h-40 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-6xl mb-4 group-hover:scale-105 transition-transform">
                  {item.emoji}
                </div>
                <div className="flex items-center gap-2 mb-3">
                  <span className={`px-3 py-1 rounded-full text-xs font-semibold ${item.color}`}>{item.tag}</span>
                  <span className="text-xs text-slate-400">{item.date}</span>
                </div>
                <h3 className="font-bold text-lg text-slate-800 mb-2">{item.title}</h3>
                <p className="text-slate-500 text-sm leading-relaxed">{item.excerpt}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
