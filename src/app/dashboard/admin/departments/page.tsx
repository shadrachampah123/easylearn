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

interface DepartmentForm {
  name: string;
  description: string;
}

const emptyForm: DepartmentForm = { name: "", description: "" };

export default function AdminDepartmentsPage() {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<DepartmentRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<DepartmentForm>(emptyForm);

  useEffect(() => {
    void loadData();
  }, []);

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

  function openCreate() {
    setEditing(null);
    setFormData(emptyForm);
    setShowForm(true);
  }

  function openEdit(department: DepartmentRow) {
    setEditing(department);
    setFormData({ name: department.name, description: department.description || "" });
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditing(null);
    setFormData(emptyForm);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");

    try {
      const response = await fetch(editing ? `/api/departments/${editing.id}` : "/api/departments", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: formData.name.trim(),
          description: formData.description.trim() || null,
        }),
      });
      const data = await response.json();

      if (!data.success) {
        alert(data.error || "Could not save the department");
        return;
      }

      closeForm();
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not save the department. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(department: DepartmentRow) {
    const subjectMessage = department.subjectCount > 0
      ? ` Its ${department.subjectCount} subject${department.subjectCount === 1 ? "" : "s"} will be kept but moved out of the department.`
      : "";
    if (!confirm(`Delete ${department.name}?${subjectMessage}`)) return;

    const token = localStorage.getItem("el_token");
    setSaving(true);
    try {
      const response = await fetch(`/api/departments/${department.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!data.success) {
        alert(data.error || "Could not delete the department");
        return;
      }
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not delete the department. Please try again.");
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
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Departments</h1>
          <p className="text-sm text-slate-500">Organize subjects into departments</p>
        </div>
        <button type="button" onClick={openCreate} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + Add Department
        </button>
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">{editing ? "Edit Department" : "Add Department"}</h2>
              <button type="button" onClick={closeForm} disabled={saving} className="text-slate-400 hover:text-slate-600 text-2xl disabled:opacity-50">&times;</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="department-name">Department Name *</label>
                <input
                  id="department-name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                  placeholder="e.g., Languages"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="department-description">Description</label>
                <textarea
                  id="department-description"
                  value={formData.description}
                  onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={closeForm} disabled={saving} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : editing ? "Save Changes" : "Add Department"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((item) => (
            <div key={item} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/2" /></div>
          ))}
        </div>
      ) : departments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">🏢</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No departments yet</h3>
          <button type="button" onClick={openCreate} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Add Department</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {departments.map((department) => (
            <div key={department.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-center justify-between mb-4">
                <div className="w-12 h-12 rounded-xl bg-purple-100 flex items-center justify-center text-2xl">
                  {deptIcons[department.name] || "🏢"}
                </div>
                <span className="px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-semibold">
                  {department.subjectCount} subject{department.subjectCount === 1 ? "" : "s"}
                </span>
              </div>
              <h3 className="font-bold text-lg text-slate-800 mb-2">{department.name}</h3>
              {department.description && <p className="text-sm text-slate-500 line-clamp-2">{department.description}</p>}
              <div className="flex gap-2 mt-5 pt-4 border-t border-slate-100">
                <button type="button" onClick={() => openEdit(department)} className="flex-1 py-2 rounded-xl bg-primary-50 text-primary-700 text-sm font-semibold hover:bg-primary-100 transition-colors">Edit</button>
                <button type="button" onClick={() => void handleDelete(department)} disabled={saving} className="flex-1 py-2 rounded-xl bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition-colors disabled:opacity-50">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
