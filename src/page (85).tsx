"use client";

import Link from "next/link";
import Navbar from "@/components/website/Navbar";
import Footer from "@/components/website/Footer";
import { useEffect, useState } from "react";

/* ── Animated Counter ── */
function Counter({ end, label, icon }: { end: number; label: string; icon: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let start = 0;
    const inc = Math.ceil(end / 40);
    const timer = setInterval(() => {
      start += inc;
      if (start >= end) { setCount(end); clearInterval(timer); }
      else setCount(start);
    }, 40);
    return () => clearInterval(timer);
  }, [end]);
  return (
    <div className="text-center p-6">
      <div className="text-4xl mb-2">{icon}</div>
      <div className="text-3xl md:text-4xl font-bold text-white">{count}+</div>
      <div className="text-blue-100 text-sm mt-1">{label}</div>
    </div>
  );
}

/* ── Feature Card ── */
function FeatureCard({ icon, title, desc, color }: { icon: string; title: string; desc: string; color: string }) {
  return (
    <div className={`p-6 rounded-3xl bg-white shadow-lg hover:shadow-xl transition-all hover:-translate-y-1 border border-slate-100 group`}>
      <div className={`w-14 h-14 rounded-2xl ${color} flex items-center justify-center text-2xl mb-4 group-hover:scale-110 transition-transform`}>
        {icon}
      </div>
      <h3 className="font-bold text-lg text-slate-800 mb-2">{title}</h3>
      <p className="text-slate-500 text-sm leading-relaxed">{desc}</p>
    </div>
  );
}

/* ── Level Card ── */
function LevelCard({ emoji, title, ages, color, desc }: { emoji: string; title: string; ages: string; color: string; desc: string }) {
  return (
    <div className={`p-6 rounded-3xl ${color} hover:scale-105 transition-all cursor-pointer shadow-md`}>
      <div className="text-5xl mb-3">{emoji}</div>
      <h3 className="font-bold text-lg text-slate-800">{title}</h3>
      <p className="text-sm text-slate-500 mb-2">Ages: {ages}</p>
      <p className="text-sm text-slate-600">{desc}</p>
    </div>
  );
}

/* ── Testimonial Card ── */
function TestimonialCard({ quote, name, role }: { quote: string; name: string; role: string }) {
  return (
    <div className="p-6 rounded-3xl bg-white shadow-lg border border-slate-100">
      <div className="text-4xl text-primary-200 mb-3">&ldquo;</div>
      <p className="text-slate-600 text-sm leading-relaxed mb-4">{quote}</p>
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-full gradient-primary flex items-center justify-center text-white font-bold text-sm">
          {name[0]}
        </div>
        <div>
          <p className="font-semibold text-sm text-slate-800">{name}</p>
          <p className="text-xs text-slate-500">{role}</p>
        </div>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Navbar />

      {/* ══ HERO SECTION ══ */}
      <section className="relative min-h-screen flex items-center overflow-hidden">
        {/* Background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary-900 via-primary-700 to-secondary-600" />
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-sunshine rounded-full blur-3xl animate-float" />
          <div className="absolute bottom-20 right-10 w-96 h-96 bg-coral rounded-full blur-3xl animate-float" style={{ animationDelay: "1s" }} />
          <div className="absolute top-1/2 left-1/2 w-80 h-80 bg-lavender rounded-full blur-3xl animate-float" style={{ animationDelay: "2s" }} />
        </div>

        {/* Floating shapes */}
        <div className="absolute inset-0 overflow-hidden">
          {["📚", "🎨", "🔬", "🎵", "⚽", "🌟", "✏️", "🎓"].map((emoji, i) => (
            <div
              key={i}
              className="absolute text-3xl md:text-4xl opacity-20 animate-float"
              style={{
                top: `${15 + (i * 10) % 70}%`,
                left: `${5 + (i * 13) % 85}%`,
                animationDelay: `${i * 0.5}s`,
                animationDuration: `${3 + i * 0.3}s`,
              }}
            >
              {emoji}
            </div>
          ))}
        </div>

        <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-32 md:py-40">
          <div className="max-w-3xl">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 text-white text-sm mb-6">
              <span className="w-2 h-2 rounded-full bg-secondary-400 animate-pulse" />
              Welcome to EasyLearn
            </div>
            <h1 className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold text-white leading-tight mb-6" style={{ fontFamily: "'Fredoka', sans-serif" }}>
              City Best International School{" "}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-sunshine to-accent-400">
                Montessori
              </span>
            </h1>
            <p className="text-lg md:text-xl text-blue-100 leading-relaxed mb-8 max-w-2xl">
              Nurturing young minds from Nursery to Junior High School with innovative, 
              technology-driven education that prepares learners for a bright future.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                href="/admissions"
                className="px-8 py-4 rounded-2xl bg-white text-primary-700 font-bold text-lg shadow-xl hover:shadow-2xl hover:scale-105 transition-all text-center"
              >
                Apply Now 🚀
              </Link>
              <Link
                href="/about"
                className="px-8 py-4 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/30 text-white font-bold text-lg hover:bg-white/20 transition-all text-center"
              >
                Learn More
              </Link>
            </div>
          </div>
        </div>

        {/* Scroll indicator */}
        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 text-white/50">
          <span className="text-xs">Scroll down</span>
          <div className="w-5 h-8 rounded-full border-2 border-white/30 flex justify-center pt-1">
            <div className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce" />
          </div>
        </div>
      </section>

      {/* ══ STATS BAR ══ */}
      <section className="gradient-primary -mt-1">
        <div className="max-w-7xl mx-auto px-4 py-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          <Counter end={500} label="Happy Learners" icon="🎓" />
          <Counter end={50} label="Expert Teachers" icon="👩‍🏫" />
          <Counter end={15} label="Years of Excellence" icon="🏆" />
          <Counter end={98} label="Success Rate %" icon="📈" />
        </div>
      </section>

      {/* ══ LEVELS SECTION ══ */}
      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 mb-3" style={{ fontFamily: "'Fredoka', sans-serif" }}>
              Our Academic Levels 📖
            </h2>
            <p className="text-slate-500 max-w-2xl mx-auto">
              From early childhood to junior high, we provide age-appropriate learning experiences
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
            <LevelCard emoji="🧒" title="Nursery" ages="2 - 4 years" color="bg-pink-50 border border-pink-100" desc="Play-based learning with songs, stories, and creative activities" />
            <LevelCard emoji="🎨" title="Kindergarten" ages="4 - 6 years" color="bg-yellow-50 border border-yellow-100" desc="Foundation skills in reading, writing, and numeracy" />
            <LevelCard emoji="📚" title="Primary" ages="6 - 12 years" color="bg-blue-50 border border-blue-100" desc="Comprehensive curriculum with hands-on projects" />
            <LevelCard emoji="🔬" title="Junior High" ages="12 - 15 years" color="bg-green-50 border border-green-100" desc="Advanced academics preparing for senior high school" />
          </div>
        </div>
      </section>

      {/* ══ FEATURES SECTION ══ */}
      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 mb-3" style={{ fontFamily: "'Fredoka', sans-serif" }}>
              Why EasyLearn? ✨
            </h2>
            <p className="text-slate-500 max-w-2xl mx-auto">
              Our platform makes learning fun, interactive, and accessible for everyone
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            <FeatureCard icon="📱" title="Learn Anywhere" desc="Access lessons, assignments, and resources from any device - phone, tablet, or computer." color="bg-blue-100" />
            <FeatureCard icon="🎮" title="Gamified Learning" desc="Earn badges, points, and climb leaderboards while learning. Education has never been this fun!" color="bg-green-100" />
            <FeatureCard icon="📊" title="Track Progress" desc="Parents and teachers can monitor performance with real-time analytics and detailed reports." color="bg-orange-100" />
            <FeatureCard icon="🎥" title="Rich Media" desc="Watch video lessons, listen to audio content, and interact with multimedia study materials." color="bg-purple-100" />
            <FeatureCard icon="📝" title="Smart Assignments" desc="Create, submit, and grade assignments with our powerful rich-text editor and auto-grading." color="bg-pink-100" />
            <FeatureCard icon="🔔" title="Stay Updated" desc="Never miss a deadline with push notifications, email alerts, and in-app reminders." color="bg-yellow-100" />
          </div>
        </div>
      </section>

      {/* ══ ABOUT PREVIEW ══ */}
      <section className="py-16 md:py-24 bg-gradient-to-br from-primary-50 to-secondary-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 mb-6" style={{ fontFamily: "'Fredoka', sans-serif" }}>
                About CBISM 🏫
              </h2>
              <p className="text-slate-600 leading-relaxed mb-4">
                City Best International School Montessori is a premier educational institution 
                committed to providing world-class education from Nursery to Junior High School. 
                Founded on the principles of the Montessori method, we blend traditional values 
                with modern teaching techniques.
              </p>
              <p className="text-slate-600 leading-relaxed mb-6">
                Our dedicated team of qualified teachers creates an inclusive, nurturing environment 
                where every child can discover their potential and develop a lifelong love for learning.
              </p>
              <div className="grid grid-cols-2 gap-4 mb-6">
                <div className="p-4 rounded-2xl bg-white shadow-sm">
                  <p className="text-2xl mb-1">🎯</p>
                  <p className="font-semibold text-sm text-slate-700">Our Vision</p>
                  <p className="text-xs text-slate-500">To be the leading school in innovative education</p>
                </div>
                <div className="p-4 rounded-2xl bg-white shadow-sm">
                  <p className="text-2xl mb-1">🌟</p>
                  <p className="font-semibold text-sm text-slate-700">Our Mission</p>
                  <p className="text-xs text-slate-500">Empowering learners to become future leaders</p>
                </div>
              </div>
              <Link href="/about" className="inline-flex items-center gap-2 text-primary-600 font-semibold hover:text-primary-700 transition-colors">
                Learn more about us →
              </Link>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-4">
                <div className="h-40 rounded-3xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center text-6xl shadow-lg">
                  📚
                </div>
                <div className="h-56 rounded-3xl bg-gradient-to-br from-secondary-400 to-secondary-600 flex items-center justify-center text-6xl shadow-lg">
                  🎨
                </div>
              </div>
              <div className="space-y-4 pt-8">
                <div className="h-56 rounded-3xl bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-6xl shadow-lg">
                  🔬
                </div>
                <div className="h-40 rounded-3xl bg-gradient-to-br from-lavender to-purple-600 flex items-center justify-center text-6xl shadow-lg">
                  🎵
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ CORE VALUES ══ */}
      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 mb-3" style={{ fontFamily: "'Fredoka', sans-serif" }}>
              Our Core Values 💎
            </h2>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {[
              { icon: "🌟", value: "Excellence" },
              { icon: "🤝", value: "Integrity" },
              { icon: "💡", value: "Innovation" },
              { icon: "❤️", value: "Compassion" },
              { icon: "🌍", value: "Diversity" },
              { icon: "📖", value: "Discipline" },
            ].map((v) => (
              <div key={v.value} className="p-5 rounded-2xl bg-white shadow-md hover:shadow-lg transition-all text-center border border-slate-100 hover:-translate-y-1">
                <div className="text-3xl mb-2">{v.icon}</div>
                <p className="font-semibold text-sm text-slate-700">{v.value}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ══ TESTIMONIALS ══ */}
      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-extrabold text-slate-800 mb-3" style={{ fontFamily: "'Fredoka', sans-serif" }}>
              What People Say 💬
            </h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <TestimonialCard
              quote="CBISM has transformed my child's learning experience. The EasyLearn platform makes it so easy to track homework and progress."
              name="Mrs. Adwoa Mensah"
              role="Parent"
            />
            <TestimonialCard
              quote="As a teacher, EasyLearn gives me powerful tools to create engaging lessons and manage my classroom efficiently."
              name="Mr. Samuel Osei"
              role="Teacher, Primary 5"
            />
            <TestimonialCard
              quote="I love earning badges and stars! The quizzes are fun and I can learn at my own pace. School is more exciting now!"
              name="Kofi Amponsah"
              role="JHS 2 Learner"
            />
          </div>
        </div>
      </section>

      {/* ══ CTA SECTION ══ */}
      <section className="py-16 md:py-24">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-3xl gradient-primary p-8 md:p-16 text-center relative overflow-hidden">
            <div className="absolute inset-0 opacity-10">
              <div className="absolute top-0 right-0 w-64 h-64 bg-white rounded-full blur-3xl" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-sunshine rounded-full blur-3xl" />
            </div>
            <div className="relative z-10">
              <h2 className="text-3xl md:text-4xl font-extrabold text-white mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>
                Ready to Join CBISM? 🎉
              </h2>
              <p className="text-blue-100 text-lg mb-8 max-w-2xl mx-auto">
                Give your child the best start in life. Apply now for the upcoming academic year and join our family of learners.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <Link href="/admissions" className="px-8 py-4 rounded-2xl bg-white text-primary-700 font-bold text-lg shadow-xl hover:shadow-2xl hover:scale-105 transition-all">
                  Start Application
                </Link>
                <Link href="/contact" className="px-8 py-4 rounded-2xl bg-white/10 border border-white/30 text-white font-bold text-lg hover:bg-white/20 transition-all">
                  Contact Us
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ══ MAP & CONTACT PREVIEW ══ */}
      <section className="py-16 md:py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-8">
            <div>
              <h2 className="text-3xl font-extrabold text-slate-800 mb-6" style={{ fontFamily: "'Fredoka', sans-serif" }}>
                Find Us 📍
              </h2>
              <div className="space-y-4 mb-6">
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-white shadow-sm">
                  <span className="text-2xl">🏫</span>
                  <div>
                    <p className="font-semibold text-slate-700">Address</p>
                    <p className="text-sm text-slate-500">123 Education Avenue, Accra, Ghana</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-white shadow-sm">
                  <span className="text-2xl">📞</span>
                  <div>
                    <p className="font-semibold text-slate-700">Phone</p>
                    <p className="text-sm text-slate-500">+233 (0) 30 123 4567</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-2xl bg-white shadow-sm">
                  <span className="text-2xl">✉️</span>
                  <div>
                    <p className="font-semibold text-slate-700">Email</p>
                    <p className="text-sm text-slate-500">info@cbism.edu</p>
                  </div>
                </div>
              </div>
            </div>
            <div className="rounded-3xl overflow-hidden shadow-lg h-80 md:h-auto">
              <iframe
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d254424.75424677!2d-0.2714!3d5.6037!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0xfdf9084b2b7a773%3A0xbed14ed8650e2dd3!2sAccra%2C+Ghana!5e0!3m2!1sen!2s!4v1"
                width="100%"
                height="100%"
                style={{ border: 0, minHeight: 300 }}
                allowFullScreen
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                title="CBISM Location"
              />
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
