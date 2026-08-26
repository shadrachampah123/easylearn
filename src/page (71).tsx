"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  maxScore: number;
  className: string | null;
  subjectName: string | null;
  createdAt: string;
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "My Classes", href: "/dashboard/teacher/classes", icon: "🏫" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
  { name: "Grades", href: "/dashboard/teacher/grades", icon: "📊" },
  { name: "Announcements", href: "/dashboard/teacher/announcements", icon: "📢" },
  { name: "Messages", href: "/dashboard/teacher/messages", icon: "💬" },
];

export default function TeacherAssignmentsPage() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    instructions: "",
    classId: "",
    subjectId: "",
    dueDate: "",
    maxScore: 100,
    allowLate: false,
    status: "draft",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    if (!token) return;

    try {
      const [assignRes, classRes, subjectRes] = await Promise.all([
        fetch("/api/assignments", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const assignData = await assignRes.json();
      const classData = await classRes.json();
      const subjectData = await subjectRes.json();

      if (assignData.success) setAssignments(assignData.data);
      if (classData.success) setClasses(classData.data);
      if (subjectData.success) setSubjects(subjectData.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/assignments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(formData),
      });

      const data = await res.json();
      if (data.success) {
        setShowForm(false);
        setFormData({
          title: "",
          description: "",
          instructions: "",
          classId: "",
          subjectId: "",
          dueDate: "",
          maxScore: 100,
          allowLate: false,
          status: "draft",
        });
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

  const statusColors: Record<string, string> = {
    draft: "bg-slate-100 text-slate-600",
    published: "bg-green-100 text-green-600",
    closed: "bg-red-100 text-red-600",
  };

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Assignments</h1>
          <p className="text-sm text-slate-500">Create and manage assignments for your classes</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-5 py-2.5 rounded-xl gradient-secondary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center gap-2"
        >
          <span>+</span> Create Assignment
        </button>
      </div>

      {/* Create Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="p-6 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">Create Assignment</h2>
                <button onClick={() => setShowForm(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Title *</label>
                <input
                  type="text"
                  required
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  placeholder="e.g., Math Homework - Chapter 5"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Class *</label>
                  <select
                    required
                    value={formData.classId}
                    onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select class</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subject *</label>
                  <select
                    required
                    value={formData.subjectId}
                    onChange={(e) => setFormData({ ...formData, subjectId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Select subject</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none resize-none"
                  placeholder="Brief description of the assignment"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Instructions</label>
                <textarea
                  value={formData.instructions}
                  onChange={(e) => setFormData({ ...formData, instructions: e.target.value })}
                  rows={4}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none resize-none"
                  placeholder="Detailed instructions for learners..."
                />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Due Date</label>
                  <input
                    type="datetime-local"
                    value={formData.dueDate}
                    onChange={(e) => setFormData({ ...formData, dueDate: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Max Score</label>
                  <input
                    type="number"
                    value={formData.maxScore}
                    onChange={(e) => setFormData({ ...formData, maxScore: parseInt(e.target.value) || 100 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Status</label>
                  <select
                    value={formData.status}
                    onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="draft">Draft</option>
                    <option value="published">Published</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="allowLate"
                  checked={formData.allowLate}
                  onChange={(e) => setFormData({ ...formData, allowLate: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300"
                />
                <label htmlFor="allowLate" className="text-sm text-slate-600">Allow late submissions</label>
              </div>
              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-secondary text-white font-semibold shadow-lg disabled:opacity-50">
                  {saving ? "Creating..." : "Create Assignment"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Assignments List */}
      {loading ? (
        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/3 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : assignments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No assignments yet</h3>
          <p className="text-slate-500 text-sm mb-6">Create your first assignment to get started</p>
          <button onClick={() => setShowForm(true)} className="px-6 py-3 rounded-xl gradient-secondary text-white font-semibold">
            Create Assignment
          </button>
        </div>
      ) : (
        <div className="grid gap-4">
          {assignments.map((assignment) => (
            <Link
              key={assignment.id}
              href={`/dashboard/teacher/assignments/${assignment.id}`}
              className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md hover:border-secondary-200 transition-all group"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 className="font-bold text-lg text-slate-800 group-hover:text-secondary-600 transition-colors">
                      {assignment.title}
                    </h3>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusColors[assignment.status] || statusColors.draft}`}>
                      {assignment.status}
                    </span>
                  </div>
                  <p className="text-slate-500 text-sm mb-3 line-clamp-2">{assignment.description || "No description"}</p>
                  <div className="flex items-center gap-4 text-xs text-slate-400">
                    <span className="flex items-center gap-1">
                      <span>🏫</span> {assignment.className}
                    </span>
                    <span className="flex items-center gap-1">
                      <span>📚</span> {assignment.subjectName}
                    </span>
                    <span className="flex items-center gap-1">
                      <span>📊</span> Max: {assignment.maxScore}
                    </span>
                    {assignment.dueDate && (
                      <span className="flex items-center gap-1">
                        <span>📅</span> Due: {new Date(assignment.dueDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-slate-300 group-hover:text-secondary-400 transition-colors text-xl">→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
