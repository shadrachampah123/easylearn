"use client";

import { useEffect, useState, useCallback } from "react";

interface UserRow {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  phone: string | null;
  gender: string | null;
  isActive: boolean;
  createdAt: string;
}

interface UsersManagerProps {
  role: "teacher" | "parent" | "learner";
  title: string;
  subtitle: string;
  emptyEmoji: string;
}

export default function UsersManager({ role, title, subtitle, emptyEmoji }: UsersManagerProps) {
  const [usersList, setUsersList] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [resetUser, setResetUser] = useState<UserRow | null>(null);
  const [resetPwd, setResetPwd] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [formSuccess, setFormSuccess] = useState("");

  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newGender, setNewGender] = useState("");

  function getToken() {
    return localStorage.getItem("el_token") || "";
  }

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const url = `/api/users?role=${role}${search ? `&search=${encodeURIComponent(search)}` : ""}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (data.success) {
        setUsersList(data.data.users || []);
      }
    } catch (err) {
      console.error("Failed to load users:", err);
    } finally {
      setLoading(false);
    }
  }, [role, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  function resetCreateForm() {
    setNewFirstName("");
    setNewLastName("");
    setNewEmail("");
    setNewPassword("");
    setNewPhone("");
    setNewGender("");
    setFormError("");
    setFormSuccess("");
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setFormSuccess("");
    setSaving(true);

    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          firstName: newFirstName,
          lastName: newLastName,
          email: newEmail,
          password: newPassword,
          phone: newPhone || undefined,
          gender: newGender || undefined,
          role,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setFormSuccess(`${newFirstName} ${newLastName} added successfully!`);
        resetCreateForm();
        setShowCreateForm(false);
        fetchUsers();
      } else {
        setFormError(data.error || "Failed to create user");
      }
    } catch (err) {
      console.error(err);
      setFormError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdateUser() {
    if (!editingUser) return;
    setSaving(true);
    setFormError("");

    try {
      const res = await fetch(`/api/users/${editingUser.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({
          firstName: editingUser.firstName,
          lastName: editingUser.lastName,
          phone: editingUser.phone,
          gender: editingUser.gender,
          isActive: editingUser.isActive,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setEditingUser(null);
        fetchUsers();
      } else {
        setFormError(data.error || "Failed to update");
      }
    } catch (err) {
      console.error(err);
      setFormError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleResetPassword() {
    if (!resetUser || resetPwd.length < 6) return;
    setSaving(true);
    setFormError("");

    try {
      const res = await fetch(`/api/users/${resetUser.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ password: resetPwd }),
      });
      const data = await res.json();
      if (data.success) {
        setResetUser(null);
        setResetPwd("");
        setFormSuccess("Password reset successfully!");
        setTimeout(() => setFormSuccess(""), 3000);
      } else {
        setFormError(data.error || "Failed to reset password");
      }
    } catch (err) {
      console.error(err);
      setFormError("Network error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteUser(user: UserRow) {
    if (!confirm(`Delete ${user.firstName} ${user.lastName}? This cannot be undone.`)) return;

    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (data.success) {
        fetchUsers();
      } else {
        alert(data.error || "Failed to delete");
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleToggleActive(user: UserRow) {
    try {
      const res = await fetch(`/api/users/${user.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      const data = await res.json();
      if (data.success) fetchUsers();
    } catch (err) {
      console.error(err);
    }
  }

  const singularTitle = title.endsWith("s") ? title.slice(0, -1) : title;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">{title}</h1>
          <p className="text-sm text-slate-500">{subtitle}</p>
        </div>
        <button
          onClick={() => { resetCreateForm(); setShowCreateForm(true); }}
          className="px-5 py-2.5 rounded-xl bg-blue-600 text-white font-semibold shadow-lg hover:bg-blue-700 hover:shadow-xl transition-all flex items-center gap-2"
        >
          <span className="text-xl">+</span> Add {singularTitle}
        </button>
      </div>

      {/* Success Message */}
      {formSuccess && (
        <div className="mb-4 p-4 rounded-xl bg-green-50 border border-green-200 text-green-700 text-sm animate-fade-in flex items-center gap-2">
          <span>✅</span> {formSuccess}
        </div>
      )}

      {/* Search */}
      <div className="mb-6">
        <div className="relative max-w-md">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${title.toLowerCase()}...`}
            className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
          />
        </div>
      </div>

      {/* ============ CREATE MODAL ============ */}
      {showCreateForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setShowCreateForm(false)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Add New {singularTitle}</h2>
              <button onClick={() => setShowCreateForm(false)} className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 text-lg">&times;</button>
            </div>
            <form onSubmit={handleCreateUser} className="p-6 space-y-4">
              {formError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm flex items-center gap-2">
                  <span>❌</span> {formError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">First Name *</label>
                  <input type="text" required value={newFirstName}
                    onChange={(e) => setNewFirstName(e.target.value)}
                    placeholder="Enter first name"
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Last Name *</label>
                  <input type="text" required value={newLastName}
                    onChange={(e) => setNewLastName(e.target.value)}
                    placeholder="Enter last name"
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email *</label>
                <input type="email" required value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="e.g. john@cbism.edu"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Password * (min 6 characters)</label>
                <input type="password" required minLength={6} value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Create a password"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                  <input type="tel" value={newPhone}
                    onChange={(e) => setNewPhone(e.target.value)}
                    placeholder="+233..."
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Gender</label>
                  <select value={newGender} onChange={(e) => setNewGender(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm">
                    <option value="">Select</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
              </div>
              <div className="flex gap-3 pt-3">
                <button type="button" onClick={() => setShowCreateForm(false)}
                  className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving}
                  className="flex-1 py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {saving ? "Adding..." : `Add ${singularTitle}`}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ============ EDIT MODAL ============ */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setEditingUser(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Edit {singularTitle}</h2>
              <button onClick={() => setEditingUser(null)} className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 text-lg">&times;</button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">❌ {formError}</div>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">First Name</label>
                  <input type="text" value={editingUser.firstName}
                    onChange={(e) => setEditingUser({ ...editingUser, firstName: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Last Name</label>
                  <input type="text" value={editingUser.lastName}
                    onChange={(e) => setEditingUser({ ...editingUser, lastName: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Email</label>
                <input type="email" value={editingUser.email} disabled
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 text-sm text-slate-400" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Phone</label>
                  <input type="tel" value={editingUser.phone || ""}
                    onChange={(e) => setEditingUser({ ...editingUser, phone: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Gender</label>
                  <select value={editingUser.gender || ""}
                    onChange={(e) => setEditingUser({ ...editingUser, gender: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                    <option value="">Select</option>
                    <option value="male">Male</option>
                    <option value="female">Female</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={editingUser.isActive}
                    onChange={(e) => setEditingUser({ ...editingUser, isActive: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300" />
                  Account Active
                </label>
              </div>
              <div className="flex gap-3 pt-3">
                <button onClick={() => { setEditingUser(null); setFormError(""); }}
                  className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200">
                  Cancel
                </button>
                <button onClick={handleUpdateUser} disabled={saving}
                  className="flex-1 py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50">
                  {saving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ RESET PASSWORD MODAL ============ */}
      {resetUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setResetUser(null)}>
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Reset Password</h2>
              <button onClick={() => setResetUser(null)} className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 text-lg">&times;</button>
            </div>
            <div className="p-6 space-y-4">
              {formError && <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">❌ {formError}</div>}
              <p className="text-sm text-slate-600">
                Reset password for <strong>{resetUser.firstName} {resetUser.lastName}</strong> ({resetUser.email})
              </p>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">New Password (min 6 chars)</label>
                <input type="password" minLength={6} value={resetPwd}
                  onChange={(e) => setResetPwd(e.target.value)}
                  placeholder="Enter new password"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setResetUser(null); setResetPwd(""); setFormError(""); }}
                  className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200">
                  Cancel
                </button>
                <button onClick={handleResetPassword} disabled={saving || resetPwd.length < 6}
                  className="flex-1 py-3 rounded-xl bg-orange-500 text-white font-semibold hover:bg-orange-600 disabled:opacity-50">
                  {saving ? "Resetting..." : "Reset Password"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ USER LIST ============ */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-5 rounded-2xl bg-white border border-slate-100">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-slate-200 animate-pulse" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 bg-slate-200 rounded w-1/3 animate-pulse" />
                  <div className="h-3 bg-slate-100 rounded w-1/2 animate-pulse" />
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : usersList.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">{emptyEmoji}</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No {title.toLowerCase()} found</h3>
          <p className="text-slate-500 text-sm mb-6">
            {search ? "Try a different search term" : `Click the button above to add your first ${singularTitle.toLowerCase()}`}
          </p>
          {!search && (
            <button onClick={() => { resetCreateForm(); setShowCreateForm(true); }}
              className="px-6 py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700">
              Add {singularTitle}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {usersList.map((user) => (
            <div key={user.id} className="p-5 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="flex items-center gap-4 flex-1 min-w-0">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold shrink-0 ${
                    role === "teacher" ? "bg-blue-100 text-blue-600" :
                    role === "parent" ? "bg-purple-100 text-purple-600" :
                    "bg-orange-100 text-orange-600"
                  }`}>
                    {user.firstName?.[0]}{user.lastName?.[0]}
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">{user.firstName} {user.lastName}</p>
                    <p className="text-xs text-slate-400 truncate">{user.email}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {user.phone && <span className="text-xs text-slate-400">📞 {user.phone}</span>}
                      <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${
                        user.isActive ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
                      }`}>
                        {user.isActive ? "Active" : "Inactive"}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button onClick={() => { setEditingUser(user); setFormError(""); }}
                    className="px-3 py-2 rounded-lg bg-blue-50 text-blue-600 text-sm font-medium hover:bg-blue-100 transition-colors">
                    ✏️ Edit
                  </button>
                  <button onClick={() => { setResetUser(user); setResetPwd(""); setFormError(""); }}
                    className="px-3 py-2 rounded-lg bg-yellow-50 text-yellow-700 text-sm font-medium hover:bg-yellow-100 transition-colors">
                    🔑 Reset
                  </button>
                  <button onClick={() => handleToggleActive(user)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                      user.isActive ? "bg-orange-50 text-orange-600 hover:bg-orange-100" : "bg-green-50 text-green-600 hover:bg-green-100"
                    }`}>
                    {user.isActive ? "Deactivate" : "Activate"}
                  </button>
                  <button onClick={() => handleDeleteUser(user)}
                    className="px-3 py-2 rounded-lg bg-red-50 text-red-600 text-sm font-medium hover:bg-red-100 transition-colors">
                    🗑️ Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
