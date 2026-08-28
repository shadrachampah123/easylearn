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
      const identifier = email.trim();
      const isEmail = identifier.includes("@");
      const loginPayload: Record<string, string> = { password };
      if (isEmail) {
        loginPayload.email = identifier;
      } else {
        loginPayload.username = identifier;
      }

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginPayload),
      });
      const data = await res.json();

      if (!res.ok || !data?.success) {
        setError(data?.error || "Login failed.");
        setLoading(false);
        return;
      }

      if (data.data.user.isActive === false) {
        setError("Account disabled. Please contact your administrator.");
        setLoading(false);
        return;
      }

      localStorage.setItem("el_token", data.data.token);
      localStorage.setItem("el_user", JSON.stringify(data.data.user));

      if (data.data.user.mustChangePassword) {
        router.push("/change-password");
        return;
      }

      const role = data.data.user.role;
      if (role === "super_admin" || role === "school_admin") router.push("/dashboard/admin");
      else if (role === "head_teacher" || role === "teacher") router.push("/dashboard/teacher");
      else if (role === "parent") router.push("/dashboard/parent");
      else router.push("/dashboard/learner");
      
      router.refresh();
    } catch (err) {
      setError("Network error. Check connection.");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Log In</h2>
        <p className="text-slate-500 text-sm mb-6">Enter your username or email and password.</p>

        {error && <div className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl">{error}</div>}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Username or Email</label>
            <input type="text" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
            <input type={showPassword ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200" />
          </div>
          <button type="submit" disabled={loading} className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700">
            {loading ? "Logging in..." : "Log In 🚀"}
          </button>
        </form>
      </div>
    </div>
  );
}