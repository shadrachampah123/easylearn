"use client";
/**
 * Login + explicit school selection.
 *
 * Merged behaviour: PR #30 supplies the complete session hand-off (username OR email,
 * `mustChangePassword` redirect, the school-scoped `el_user` session object) and PR #31
 * supplies the "that school is no longer available" wording for a selection that the server
 * refuses. The school list itself is server-validated — the client only ever asks for a
 * school the server already listed as one of the caller's active memberships.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

type SchoolSummary = {
  schoolId: string;
  membershipId: string;
  slug: string;
  name: string;
  role: string;
};
type SessionUser = {
  id: string;
  email: string;
  role: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string | null;
  isActive?: boolean;
  mustChangePassword?: boolean;
};

function dashboardPath(role: string) {
  if (role === "super_admin" || role === "school_admin") return "/dashboard/admin";
  if (role === "head_teacher" || role === "teacher") return "/dashboard/teacher";
  if (role === "parent") return "/dashboard/parent";
  return "/dashboard/learner";
}

export default function LoginPage() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [pendingToken, setPendingToken] = useState("");
  const [pendingUser, setPendingUser] = useState<SessionUser | null>(null);
  const [schools, setSchools] = useState<SchoolSummary[]>([]);

  function continueToApp(user: SessionUser, school: SchoolSummary | null, token: string, memberships: SchoolSummary[]) {
    const sessionUser = {
      ...user,
      globalRole: user.role,
      role: school?.role ?? user.role,
      school,
      schools: memberships,
    };
    localStorage.setItem("el_token", token);
    localStorage.setItem("el_user", JSON.stringify(sessionUser));
    if (user.mustChangePassword) {
      router.push("/change-password");
      return;
    }
    router.push(dashboardPath(sessionUser.role));
    router.refresh();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const value = identifier.trim();
      const loginPayload: Record<string, string> = { password };
      if (value.includes("@")) loginPayload.email = value;
      else loginPayload.username = value;

      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(loginPayload),
      });
      const data = await res.json();

      if (!res.ok || !data?.success) {
        setError(data?.error || "Login failed.");
        return;
      }

      const user = data.data.user as SessionUser;
      const userSchools = (data.data.schools ?? []) as SchoolSummary[];
      const token = data.data.token as string;
      if (user.isActive === false) {
        setError("Account disabled. Please contact your administrator.");
        return;
      }

      if (userSchools.length > 1) {
        // Do not navigate to any school dashboard until the user explicitly chooses one.
        setPendingToken(token);
        setPendingUser(user);
        setSchools(userSchools);
        return;
      }

      continueToApp(user, data.data.school ?? null, token, userSchools);
    } catch {
      setError("Network error. Check connection.");
    } finally {
      setLoading(false);
    }
  }

  async function handleSchoolChoice(school: SchoolSummary) {
    if (!pendingToken || !pendingUser) return;
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/select-school", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pendingToken}`,
        },
        body: JSON.stringify({ schoolId: school.schoolId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.success) {
        setError(data?.error || "That school is no longer available. Please sign in again.");
        return;
      }
      continueToApp(pendingUser, data.data.school, data.data.token, data.data.schools);
    } catch {
      setError("Network error. Check connection.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md bg-white p-8 rounded-2xl shadow-xl border border-slate-100">
        <h2 className="text-2xl font-bold text-slate-800 mb-2">Log In</h2>
        <p className="text-slate-500 text-sm mb-6">
          {pendingUser
            ? `Choose a school to continue, ${pendingUser.firstName}.`
            : "Enter your username or email and password."}
        </p>

        {error && <div role="alert" className="mb-4 p-3 bg-red-50 text-red-600 text-sm rounded-xl">{error}</div>}

        {pendingUser ? (
          <div className="space-y-3">
            {schools.map((school) => (
              <button
                key={school.membershipId}
                type="button"
                disabled={loading}
                onClick={() => handleSchoolChoice(school)}
                className="w-full rounded-xl border border-slate-200 px-4 py-4 text-left hover:border-blue-400 hover:bg-blue-50 disabled:opacity-50"
              >
                <span className="block font-semibold text-slate-800">{school.name}</span>
                <span className="block text-sm text-slate-500">{school.role.replaceAll("_", " ")}</span>
              </button>
            ))}
            {loading && <p className="text-sm text-slate-500 text-center">Opening your school…</p>}
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Username or Email</label>
              <input type="text" required value={identifier} onChange={(e) => setIdentifier(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Password</label>
              <input type={showPassword ? "text" : "password"} required value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-3 rounded-xl border border-slate-200" />
              <button type="button" onClick={() => setShowPassword(!showPassword)} className="mt-2 text-xs text-blue-600">
                {showPassword ? "Hide password" : "Show password"}
              </button>
            </div>
            <button type="submit" disabled={loading} className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold hover:bg-blue-700 disabled:opacity-50">
              {loading ? "Logging in…" : "Log In 🚀"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
