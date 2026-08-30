"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface SubjectRow {
  id: string;
  name: string;
  code: string | null;
  departmentId: string | null;
  description: string | null;
}

interface Department {
  id: string;
  name: string;
}

interface SubjectForm {
  name: string;
  code: string;
  departmentId: string;
  description: string;
}

const emptyForm: SubjectForm = { name: "", code: "", departmentId: "", description: "" };

export default function AdminSubjectsPage() {
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<SubjectRow | null>(null);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState<SubjectForm>(emptyForm);

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [subjectResponse, departmentResponse] = await Promise.all([
        fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/departments", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const subjectData = await subjectResponse.json();
      const departmentData = await departmentResponse.json();
      if (subjectData.success) setSubjects(subjectData.data);
      if (departmentData.success) setDepartments(departmentData.data);
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

  function openEdit(subject: SubjectRow) {
    setEditing(subject);
    setFormData({
      name: subject.name,
      code: subject.code || "",
      departmentId: subject.departmentId || "",
      description: subject.description || "",
    });
    setShowForm(true);
  }

  function closeForm() {
    if (saving) return;
    setShowForm(false);
    setEditing(null);
    setFormData(emptyForm);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");

    try {
      const response = await fetch(editing ? `/api/subjects/${editing.id}` : "/api/subjects", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: formData.name.trim(),
          code: formData.code.trim() || null,
          departmentId: formData.departmentId || null,
          description: formData.description.trim() || null,
        }),
      });
      const data = await response.json();

      if (!data.success) {
        alert(data.error || "Could not save the subject");
        return;
      }

      setShowForm(false);
      setEditing(null);
      setFormData(emptyForm);
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not save the subject. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(subject: SubjectRow) {
    if (!confirm(`Delete ${subject.name}? Any assignments, quizzes, and teacher assignments using this subject will also be removed.`)) return;

    const token = localStorage.getItem("el_token");
    setSaving(true);
    try {
      const response = await fetch(`/api/subjects/${subject.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!data.success) {
        alert(data.error || "Could not delete the subject");
        return;
      }
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not delete the subject. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const filtered = subjects.filter((subject) =>
    subject.name.toLowerCase().includes(search.toLowerCase()) ||
    (subject.code && subject.code.toLowerCase().includes(search.toLowerCase()))
  );

  const getDepartmentName = (id: string | null) => departments.find((department) => department.id === id)?.name || "No Department";

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Subjects</h1>
          <p className="text-sm text-slate-500">Manage subjects across all academic levels</p>
        </div>
        <button type="button" onClick={openCreate} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + Add Subject
        </button>
      </div>

      <div className="mb-6 relative max-w-md">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
        <input
          type="text"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search subjects..."
          className="w-full pl-10 pr-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 outline-none text-sm"
        />
      </div>

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">{editing ? "Edit Subject" : "Add Subject"}</h2>
              <button type="button" onClick={closeForm} disabled={saving} className="text-slate-400 hover:text-slate-600 text-2xl disabled:opacity-50">&times;</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="subject-name">Subject Name *</label>
                <input
                  id="subject-name"
                  type="text"
                  required
                  value={formData.name}
                  onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                  placeholder="e.g., Integrated Science"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="subject-code">Subject Code</label>
                <input
                  id="subject-code"
                  type="text"
                  value={formData.code}
                  onChange={(event) => setFormData({ ...formData, code: event.target.value })}
                  placeholder="e.g., SCI"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="subject-department">Department</label>
                <select
                  id="subject-department"
                  value={formData.departmentId}
                  onChange={(event) => setFormData({ ...formData, departmentId: event.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">No department</option>
                  {departments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="subject-description">Description</label>
                <textarea
                  id="subject-description"
                  value={formData.description}
                  onChange={(event) => setFormData({ ...formData, description: event.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={closeForm} disabled={saving} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : editing ? "Save Changes" : "Add Subject"}
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
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📚</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No subjects found</h3>
          <button type="button" onClick={openCreate} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Add Subject</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((subject) => (
            <div key={subject.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-center justify-between mb-3">
                <div className="w-12 h-12 rounded-xl bg-blue-100 flex items-center justify-center text-2xl">📚</div>
                <span className="text-xs text-slate-400">{getDepartmentName(subject.departmentId)}</span>
              </div>
              <h3 className="font-bold text-lg text-slate-800">{subject.name}</h3>
              {subject.code && <p className="text-sm text-primary-600 font-semibold">{subject.code}</p>}
              {subject.description && <p className="text-sm text-slate-500 mt-1 line-clamp-2">{subject.description}</p>}
              <div className="flex gap-2 mt-5 pt-4 border-t border-slate-100">
                <button type="button" onClick={() => openEdit(subject)} className="flex-1 py-2 rounded-xl bg-primary-50 text-primary-700 text-sm font-semibold hover:bg-primary-100 transition-colors">Edit</button>
                <button type="button" onClick={() => void handleDelete(subject)} disabled={saving} className="flex-1 py-2 rounded-xl bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition-colors disabled:opacity-50">Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
