"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface UserItem {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

export default function AdminUsersPage() {
  const [userList, setUserList] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{ username: string; tempPassword: string } | null>(null);

  // New User Form State
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    role: "learner",
    phone: "",
    gender: "male",
  });
  const [formError, setFormError] = useState("");
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Fetch Users on Load
  useEffect(() => {
    fetchUsers();
  }, []);

  async function fetchUsers() {
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json();
      if (data.success) {
        setUserList(data.data);
      }
    } catch (err) {
      console.error("Failed to fetch users", err);
    } finally {
      setLoading(false);
    }
  }

  // Handle Account Creation
  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setFormSubmitting(true);

    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setFormError(data.error || "Failed to create account.");
        setFormSubmitting(false);
        return;
      }

      // Store generated credentials to show to Admin
      setCreatedCredentials(data.data.credentials);
      setShowModal(false);
      setForm({ firstName: "", lastName: "", email: "", role: "learner", phone: "", gender: "male" });
      fetchUsers(); // Refresh list
    } catch (err) {
      setFormError("Network error. Please try again.");
    } finally {
      setFormSubmitting(false);
    }
  }

  // Handle Toggle Active/Deactive Status
  async function toggleStatus(userId: string, currentStatus: boolean) {
    try {
      await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !currentStatus }),
      });
      fetchUsers();
    } catch (err) {
      alert("Failed to update user status.");
    }
  }

  // Handle Reset Credentials
  async function handleResetPassword(userId: string, userName: string) {
    if (!confirm(`Are you sure you want to reset credentials for ${userName}?`)) return;

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_password" }),
      });
      const data = await res.json();
      if (data.success) {
        setCreatedCredentials({
          username: userName,
          tempPassword: data.credentials.tempPassword,
        });
      }
    } catch (err) {
      alert("Failed to reset password.");
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 p-6 lg:p-10">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">User Account Management</h1>
            <p className="text-slate-500 text-sm">Create and manage accounts for Learners, Parents, and Teachers.</p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/dashboard/admin" className="px-4 py-2.5 rounded-xl border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 transition-all">
              ← Dashboard
            </Link>
            <button
              onClick={() => setShowModal(true)}
              className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm shadow-md transition-all flex items-center gap-2"
            >
              <span>➕</span> Add New User
            </button>
          </div>
        </div>

        {/* Credentials Display Banner (When created/reset) */}
        {createdCredentials && (
          <div className="p-6 rounded-2xl bg-amber-50 border-2 border-amber-300 shadow-md">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-lg font-bold text-amber-900 flex items-center gap-2">
                  <span>🎉</span> Account Credentials Generated Successfully!
                </h3>
                <p className="text-amber-800 text-sm mt-1">
                  Please copy these credentials and send them to the user. The user will be required to change this temporary password upon first login.
                </p>
                <div className="mt-4 p-4 bg-white rounded-xl border border-amber-200 inline-block font-mono text-slate-800 text-sm space-y-1">
                  <p><strong>Username:</strong> <span className="text-blue-600">{createdCredentials.username}</span></p>
                  <p><strong>Temporary Password:</strong> <span className="text-amber-700">{createdCredentials.tempPassword}</span></p>
                </div>
              </div>
              <button
                onClick={() => setCreatedCredentials(null)}
                className="text-amber-700 hover:text-amber-900 font-bold text-lg"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Users Table */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-600">
              <thead className="bg-slate-50 text-slate-700 font-semibold border-b border-slate-200">
                <tr>
                  <th className="p-4">Name</th>
                  <th className="p-4">Username</th>
                  <th className="p-4">Email</th>
                  <th className="p-4">Role</th>
                  <th className="p-4">Status</th>
                  <th className="p-4">First Login</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {loading ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400">Loading accounts...</td>
                  </tr>
                ) : userList.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400">No user accounts found.</td>
                  </tr>
                ) : (
                  userList.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50/50 transition-all">
                      <td className="p-4 font-semibold text-slate-800">{u.firstName} {u.lastName}</td>
                      <td className="p-4 font-mono text-xs text-blue-600">{u.username || "—"}</td>
                      <td className="p-4">{u.email}</td>
                      <td className="p-4">
                        <span className="capitalize px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                          {u.role.replace("_", " ")}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${u.isActive ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
                          {u.isActive ? "Active" : "Deactivated"}
                        </span>
                      </td>
                      <td className="p-4">
                        <span className={`text-xs ${u.mustChangePassword ? "text-amber-600 font-semibold" : "text-slate-400"}`}>
                          {u.mustChangePassword ? "Pending Password Change" : "Completed"}
                        </span>
                      </td>
                      <td className="p-4 text-right space-x-2">
                        <button
                          onClick={() => toggleStatus(u.id, u.isActive)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                            u.isActive ? "border-red-200 text-red-600 hover:bg-red-50" : "border-emerald-200 text-emerald-600 hover:bg-emerald-50"
                          }`}
                        >
                          {u.isActive ? "Deactivate" : "Activate"}
                        </button>
                        <button
                          onClick={() => handleResetPassword(u.id, u.username || u.email)}
                          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 text-slate-600 hover:bg-slate-100 transition-all"
                        >
                          Reset Pass
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Add User Modal */}
      {showModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <h3 className="text-lg font-bold text-slate-800">Add New User</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>

            {formError && <div className="p-3 bg-red-50 text-red-600 text-xs rounded-xl">{formError}</div>}

            <form onSubmit={handleCreateUser} className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">First Name</label>
                  <input type="text" required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    className="w-full px-3 py-2 border rounded-xl" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Last Name</label>
                  <input type="text" required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    className="w-full px-3 py-2 border rounded-xl" />
                </div>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Email</label>
                <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 border rounded-xl" />
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">Role</label>
                <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className="w-full px-3 py-2 border rounded-xl bg-white">
                  <option value="learner">🎓 Learner</option>
                  <option value="parent">👨‍👩‍👧 Parent</option>
                  <option value="teacher">👩‍🏫 Teacher</option>
                  <option value="head_teacher">👨‍🏫 Head Teacher</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Phone</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="w-full px-3 py-2 border rounded-xl" />
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Gender</label>
                  <select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })} className="w-full px-3 py-2 border rounded-xl bg-white">
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
              </div>

              <div className="pt-3 flex gap-2">
                <button type="button" onClick={() => setShowModal(false)} className="w-1/2 py-2.5 rounded-xl border text-slate-600 font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={formSubmitting} className="w-1/2 py-2.5 rounded-xl bg-blue-600 text-white font-semibold shadow-md">
                  {formSubmitting ? "Creating..." : "Create Account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}