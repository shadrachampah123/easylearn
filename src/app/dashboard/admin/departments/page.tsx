"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface DepartmentRow {
  id: string;
  name: string;
  description: string | null;
  subjectCount: number;
}

export default function AdminDepartmentsPage() {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({ name: "", description: "" });

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/departments", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setDepartments(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/departments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        setShowCreate(false);
        setFormData({ name: "", description: "" });
        loadData();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  const deptIcons: Record<string, string> = {
    Sciences: "🔬", Languages: "💬", Mathematics: "➗",
    "Social Studies": "🌍", "Creative Arts": "🎨",
  };

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Departments</h1>
          <p className="text-sm text-slate-500">Organize subjects into departments</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + Add Department
        </button>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Add Department</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Department Name *</label>
                <input type="text" required value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Languages"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none" />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Adding..." : "Add Department"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/2" /></div>
          ))}
        </div>
      ) : departments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">🏢</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No departments yet</h3>
          <button onClick={() => setShowCreate(true)} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Add Department</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map((dept) => (
            <div key={dept.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center text-2xl">
                  {deptIcons[dept.name] || "🏢"}
                </div>
                <span className="px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-semibold">
                  {dept.subjectCount} subjects
                </span>
              </div>
              <h3 className="font-bold text-lg text-slate-800 mb-2">{dept.name}</h3>
              {dept.description && <p className="text-sm text-slate-500 line-clamp-2">{dept.description}</p>}
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
