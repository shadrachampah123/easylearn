"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        cache: "no-store",
        body: JSON.stringify({ email: email.trim(), password }),
      });

      const contentType = res.headers.get("content-type") || "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : null;

      if (!res.ok || !data?.success) {
        setError(
          data?.error ||
          `Login failed (HTTP ${res.status}). Check /api/health and the Vercel function logs.`
        );
        return;
      }

      localStorage.setItem("el_token", data.data.token);
      localStorage.setItem("el_user", JSON.stringify(data.data.user));

      const role = data.data.user.role;
      if (role === "super_admin" || role === "school_admin") {
        router.push("/dashboard/admin");
      } else if (role === "head_teacher" || role === "teacher") {
        router.push("/dashboard/teacher");
      } else if (role === "parent") {
        router.push("/dashboard/parent");
      } else {
        router.push("/dashboard/learner");
      }
      router.refresh();
    } catch (requestError) {
      console.error("Login request failed:", requestError);
      setError("Unable to reach the authentication service. Check your connection and Vercel deployment logs.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex">
      {/* Left Side - Decorative */}
      <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-primary-600 via-primary-700 to-secondary-600 p-12 items-center justify-center relative overflow-hidden">
        <div className="absolute inset-0 opacity-10">
          {["📚", "🎓", "✏️", "🔬", "🎨", "🌟", "💡", "🎵"].map((e, i) => (
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
            Welcome Back! 👋
          </h1>
          <p className="text-blue-100 text-lg leading-relaxed">
            Log in to your EasyLearn account to access your dashboard, assignments, grades, and more.
          </p>
          <div className="mt-8 grid grid-cols-2 gap-4">
            <div className="p-4 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20">
              <p className="text-2xl mb-1">📝</p>
              <p className="text-sm font-medium">Assignments</p>
            </div>
            <div className="p-4 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20">
              <p className="text-2xl mb-1">📊</p>
              <p className="text-sm font-medium">Analytics</p>
            </div>
            <div className="p-4 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20">
              <p className="text-2xl mb-1">💬</p>
              <p className="text-sm font-medium">Messages</p>
            </div>
            <div className="p-4 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20">
              <p className="text-2xl mb-1">🏆</p>
              <p className="text-sm font-medium">Achievements</p>
            </div>
          </div>
        </div>
      </div>

      {/* Right Side - Form */}
      <div className="flex-1 flex items-center justify-center p-6 bg-slate-50">
        <div className="w-full max-w-md">
          <div className="text-center mb-8 lg:hidden">
            <Link href="/" className="inline-flex items-center gap-2">
              <div className="w-12 h-12 rounded-2xl gradient-primary flex items-center justify-center text-white font-bold text-xl">EL</div>
            </Link>
          </div>

          <h2 className="text-2xl font-bold text-slate-800 mb-2">Log In to EasyLearn</h2>
          <p className="text-slate-500 text-sm mb-8">Enter your credentials to access your account.</p>

          {error && (
            <div className="mb-4 p-4 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm animate-scale-in">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="your@email.com"
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  placeholder="••••••••"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none text-sm bg-white pr-12"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-sm"
                >
                  {showPassword ? "🙈" : "👁️"}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between text-sm">
              <label className="flex items-center gap-2 text-slate-600">
                <input type="checkbox" className="rounded border-slate-300" />
                Remember me
              </label>
              <a href="#" className="text-primary-600 hover:text-primary-700 font-medium">
                Forgot password?
              </a>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-[1.02] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Logging in...
                </span>
              ) : (
                "Log In 🚀"
              )}
            </button>
          </form>

          <p className="text-center text-sm text-slate-500 mt-6">
            Don&apos;t have an account?{" "}
            <Link href="/register" className="text-primary-600 font-semibold hover:text-primary-700">
              Register here
            </Link>
          </p>

          {/* Demo Accounts */}
          <div className="mt-8 p-4 rounded-xl bg-blue-50 border border-blue-100">
            <p className="text-xs font-semibold text-blue-700 mb-2">Demo Accounts (after seeding):</p>
            <div className="space-y-1 text-xs text-blue-600">
              <p>Admin: admin@cbism.edu / admin123</p>
              <p>Teacher: teacher@cbism.edu / teacher123</p>
              <p>Parent: parent@cbism.edu / parent123</p>
              <p>Learner: learner@cbism.edu / learner123</p>
            </div>
          </div>

          <p className="text-center text-xs text-slate-400 mt-6">
            <Link href="/" className="hover:text-primary-600">← Back to website</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
