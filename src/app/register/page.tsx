"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: "", lastName: "", email: "", password: "", confirmPassword: "", role: "learner", phone: "", gender: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (form.password.length < 6) {
      setError("Password must be at least 6 characters");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ ...form, email: form.email.trim() }),
      });

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : null;

      if (!res.ok || !data?.success) {
        setError(
          data?.error ||
          `Registration failed (HTTP ${res.status}). Check /api/health and the Vercel function logs.`
        );
        return;
      }

      localStorage.setItem("el_token", data.data.token);
      localStorage.setItem("el_user", JSON.stringify(data.data.user));

      const role = data.data.user.role;
      if (role === "parent") router.push("/dashboard/parent");
      else if (role === "teacher") router.push("/dashboard/teacher");
      else router.push("/dashboard/learner");
      router.refresh();
    } catch (requestError) {
      console.error("Registration request failed:", requestError);
      setError("Unable to reach the registration service. Check your connection and Vercel deployment logs.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left - Decorative */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-secondary-600 via-secondary-700 to-primary-600 p-12 items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          {["🎓", "📖", "🌟", "🎨", "🔬", "💻", "🏆", "🎵"].map((e, i) => (
            <div key={i} className="absolute text-5xl animate-float" style={{ top: `${10 + i * 10}%`, left: `${5 + i * 12}%`, animationDelay: `${i * 0.5}s` }}>
              {e}
            </div>
          ))}
        </div>
        <div className="relative z-10 text-white max-w-md">
          <div className="w-20 h-20 rounded-3xl bg-white/10 backdrop-blur-sm flex items-center justify-center text-3xl font-bold mb-8 border border-white/20">
            EL
          </div>
          <h1 className="text-4xl font-extrabold mb-4" style={{ fontFamily: "'Fredoka', sans-serif" }}>
            Join EasyLearn! 🎉
          </h1>
          <p className="text-green-100 text-lg leading-relaxed">
            Create your account to access our powerful learning platform. Whether you&apos;re a learner, parent, or teacher — we have the tools you need.
          </p>
        </div>
      </div>

      {/* Right - Form */}
      <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
        <div className="w-full max-w-md">
          <div className="text-center mb-6 lg:hidden">
            <Link href="/" className="inline-flex items-center gap-2">
              <div className="w-12 h-12 rounded-2xl gradient-secondary flex items-center justify-center text-white font-bold text-xl">EL</div>
            </Link>
          </div>

          <h2 className="text-2xl font-bold text-slate-800 mb-2">Create Account</h2>
          <p className="text-slate-500 text-sm mb-6">Fill in your details to get started.</p>

          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm animate-scale-in">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                <input type="text" required value={form.firstName} onChange={(e) => updateField("firstName", e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                <input type="text" required value={form.lastName} onChange={(e) => updateField("lastName", e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input type="email" required value={form.email} onChange={(e) => updateField("email", e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">I am a...</label>
              <select value={form.role} onChange={(e) => updateField("role", e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white">
                <option value="learner">🎓 Learner</option>
                <option value="parent">👨‍👩‍👧 Parent</option>
                <option value="teacher">👩‍🏫 Teacher</option>
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                <input type="tel" value={form.phone} onChange={(e) => updateField("phone", e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gender</label>
                <select value={form.gender} onChange={(e) => updateField("gender", e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white">
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input type="password" required value={form.password} onChange={(e) => updateField("password", e.target.value)}
                placeholder="Min 6 characters"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Confirm Password</label>
              <input type="password" required value={form.confirmPassword} onChange={(e) => updateField("confirmPassword", e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white" />
            </div>

            <button type="submit" disabled={loading}
              className="w-full py-3 rounded-xl gradient-secondary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all disabled:opacity-50">
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Creating account...
                </span>
              ) : "Create Account 🎉"}
            </button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-6">
            Already have an account?{" "}
            <Link href="/login" className="text-primary-600 font-semibold hover:text-primary-700">Log in here</Link>
          </p>
          <p className="text-center text-xs text-slate-400 mt-4">
            <Link href="/" className="hover:text-primary-600">← Back to website</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
