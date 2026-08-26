"use client";

import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";

const downloadItems = [
  { title: "School Prospectus 2024/2025", category: "General", icon: "📄", size: "2.5 MB" },
  { title: "Admission Application Form", category: "Admissions", icon: "📝", size: "500 KB" },
  { title: "Academic Calendar", category: "General", icon: "📅", size: "1.2 MB" },
  { title: "Fee Structure", category: "Finance", icon: "💰", size: "300 KB" },
  { title: "School Rules & Regulations", category: "General", icon: "📋", size: "800 KB" },
  { title: "Uniform Guide", category: "General", icon: "👔", size: "1.5 MB" },
  { title: "Bus Routes & Schedule", category: "Transport", icon: "🚌", size: "400 KB" },
  { title: "Holiday Homework Template", category: "Academic", icon: "📚", size: "600 KB" },
];

export default function DownloadsPage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 bg-gradient-to-br from-sunshine to-amber-600 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-4xl md:text-5xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>Downloads 📥</h1>
          <p className="text-amber-100 text-lg max-w-2xl mx-auto">Download important school documents and forms.</p>
        </div>
      </section>

      <section className="py-16 md:py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="space-y-3">
            {downloadItems.map((item, i) => (
              <div key={i} className="flex items-center justify-between p-5 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all group">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
                    {item.icon}
                  </div>
                  <div>
                    <p className="font-semibold text-slate-700">{item.title}</p>
                    <p className="text-xs text-slate-400">{item.category} • {item.size}</p>
                  </div>
                </div>
                <button className="px-4 py-2 rounded-xl bg-primary-50 text-primary-600 text-sm font-semibold hover:bg-primary-100 transition-colors">
                  Download
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
