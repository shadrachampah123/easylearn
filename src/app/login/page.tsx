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
  const [schoolOptions, setSchoolOptions] = useState<Array<{ schoolId: string; schoolName: string; schoolSlug: string; role: string }>>([]);
  const [selectionToken, setSelectionToken] = useState("");

  function continueToDashboard(role: string) {
    if (role === "super_admin" || role === "school_admin") router.push("/dashboard/admin");
    else if (role === "head_teacher" || role === "teacher") router.push("/dashboard/teacher");
    else if (role === "parent") router.push("/dashboard/parent");
    else router.push("/dashboard/learner");
    router.refresh();
  }

  async function selectSchool(schoolId: string) {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/select-school", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${selectionToken}` },
        body: JSON.stringify({ schoolId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "That school is no longer available. Please sign in again.");
        setLoading(false);
        return;
      }
      localStorage.setItem("el_token", data.data.token);
      setSchoolOptions([]);
      setSelectionToken("");
      continueToDashboard(data.data.user.role);
    } catch {
      setError("Network error. Check connection.");
    } finally {
      setLoading(false);
    }
  }

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

      if (data.data.school === null && Array.isArray(data.data.schools) && data.data.schools.length > 1) {
        setSelectionToken(data.data.token);
        setSchoolOptions(data.data.schools);
        setLoading(false);
        return;
      }

      continueToDashboard(data.data.user.role);
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

        {schoolOptions.length > 0 ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-600">Choose the school you want to open. You can change it by signing out and selecting again.</p>
            {schoolOptions.map((school) => (
              <button
                key={school.schoolId}
                type="button"
                disabled={loading}
                onClick={() => selectSchool(school.schoolId)}
                className="w-full text-left p-4 rounded-xl border border-slate-200 hover:border-blue-500 hover:bg-blue-50 disabled:opacity-60"
              >
                <span className="block font-semibold text-slate-800">{school.schoolName}</span>
                <span className="block text-sm text-slate-500">{school.role} · {school.schoolSlug}</span>
              </button>
            ))}
          </div>
        ) : (
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
        )}
      </div>
    </div>
  );
}