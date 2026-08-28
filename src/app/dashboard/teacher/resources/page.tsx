"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";

interface Resource {
  id: string;
  title: string;
  description: string | null;
  type: string;
  fileUrl: string | null;
  fileSize: number | null;
  topic: string | null;
  week: number | null;
  isPinned: boolean;
  isApproved: boolean;
  className: string | null;
  subjectName: string | null;
  createdAt: string;
}

const teacherNav = [
  { name: "Dashboard", href: "/dashboard/teacher", icon: "📊" },
  { name: "Assignments", href: "/dashboard/teacher/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/teacher/quizzes", icon: "❓" },
  { name: "Resources", href: "/dashboard/teacher/resources", icon: "📚" },
  { name: "Attendance", href: "/dashboard/teacher/attendance", icon: "✅" },
];

const resourceTypes = [
  { value: "pdf", label: "PDF", icon: "📄" },
  { value: "docx", label: "Word Doc", icon: "📝" },
  { value: "pptx", label: "PowerPoint", icon: "📊" },
  { value: "video", label: "Video", icon: "🎥" },
  { value: "audio", label: "Audio", icon: "🎵" },
  { value: "image", label: "Image", icon: "🖼️" },
  { value: "link", label: "Link", icon: "🔗" },
];

export default function TeacherResourcesPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [classes, setClasses] = useState<{ id: string; name: string }[]>([]);
  const [subjects, setSubjects] = useState<{ id: string; name: string }[]>([]);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    type: "pdf",
    fileUrl: "",
    classId: "",
    subjectId: "",
    topic: "",
    week: 1,
    isPinned: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    if (!token) return;

    try {
      const [resourceRes, classRes, subjectRes] = await Promise.all([
        fetch("/api/resources", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/subjects", { headers: { Authorization: `Bearer ${token}` } }),
      ]);

      const resourceData = await resourceRes.json();
      const classData = await classRes.json();
      const subjectData = await subjectRes.json();

      if (resourceData.success) setResources(resourceData.data);
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
      const res = await fetch("/api/resources", {
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
          type: "pdf",
          fileUrl: "",
          classId: "",
          subjectId: "",
          topic: "",
          week: 1,
          isPinned: false,
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

  const typeIcons: Record<string, string> = {
    pdf: "📄",
    docx: "📝",
    pptx: "📊",
    video: "🎥",
    audio: "🎵",
    image: "🖼️",
    link: "🔗",
    zip: "📦",
  };

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Study Materials</h1>
          <p className="text-sm text-slate-500">Upload notes, videos, and other learning resources</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-5 py-2.5 rounded-xl gradient-secondary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center gap-2"
        >
          <span>+</span> Upload Resource
        </button>
      </div>

      {/* Upload Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto animate-scale-in">
            <div className="p-6 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">Upload Resource</h2>
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
                  placeholder="e.g., Chapter 3 Notes - Forces"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Resource Type *</label>
                <div className="grid grid-cols-4 gap-2">
                  {resourceTypes.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setFormData({ ...formData, type: t.value })}
                      className={`p-3 rounded-xl text-center transition-all ${
                        formData.type === t.value
                          ? "bg-secondary-100 border-2 border-secondary-500 text-secondary-700"
                          : "bg-slate-50 border-2 border-transparent hover:bg-slate-100"
                      }`}
                    >
                      <div className="text-2xl mb-1">{t.icon}</div>
                      <div className="text-xs font-medium">{t.label}</div>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {formData.type === "link" ? "URL (optional)" : "File URL (optional)"}
                </label>
                <input
                  type="url"
                  value={formData.fileUrl}
                  onChange={(e) => setFormData({ ...formData, fileUrl: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  placeholder={formData.type === "link" ? "https://youtube.com/..." : "https://drive.google.com/..."}
                />
                <p className="text-xs text-slate-400 mt-1">
                  Paste a direct link to the file (Google Drive, Dropbox, YouTube, etc.)
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Class</label>
                  <select
                    value={formData.classId}
                    onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  >
                    <option value="">All classes</option>
                    {classes.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
                  <select
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

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Topic</label>
                  <input
                    type="text"
                    value={formData.topic}
                    onChange={(e) => setFormData({ ...formData, topic: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                    placeholder="e.g., Forces and Motion"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Week</label>
                  <input
                    type="number"
                    min={1}
                    max={52}
                    value={formData.week}
                    onChange={(e) => setFormData({ ...formData, week: parseInt(e.target.value) || 1 })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  rows={3}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-secondary-500 focus:border-transparent outline-none resize-none"
                  placeholder="Brief description of this resource..."
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="isPinned"
                  checked={formData.isPinned}
                  onChange={(e) => setFormData({ ...formData, isPinned: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300"
                />
                <label htmlFor="isPinned" className="text-sm text-slate-600">📌 Pin this resource (show at top)</label>
              </div>

              <div className="flex gap-3 pt-4">
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-secondary text-white font-semibold shadow-lg disabled:opacity-50">
                  {saving ? "Uploading..." : "Upload Resource"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Resources List */}
      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/2 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : resources.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📚</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No resources yet</h3>
          <p className="text-slate-500 text-sm mb-6">Upload your first study material</p>
          <button onClick={() => setShowForm(true)} className="px-6 py-3 rounded-xl gradient-secondary text-white font-semibold">
            Upload Resource
          </button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {resources.map((resource) => (
            <div
              key={resource.id}
              className="p-5 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-2xl group-hover:scale-110 transition-transform">
                  {typeIcons[resource.type] || "📁"}
                </div>
                <div className="flex items-center gap-1">
                  {resource.isPinned && <span title="Pinned">📌</span>}
                  {resource.isApproved ? (
                    <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-600 text-xs">Approved</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 text-xs">Pending</span>
                  )}
                </div>
              </div>
              <h3 className="font-bold text-slate-800 mb-1 line-clamp-1 group-hover:text-secondary-600 transition-colors">
                {resource.title}
              </h3>
              <p className="text-slate-500 text-sm mb-3 line-clamp-2">{resource.description || "No description"}</p>
              <div className="flex items-center gap-2 text-xs text-slate-400 mb-3">
                {resource.subjectName && <span className="flex items-center gap-1">📚 {resource.subjectName}</span>}
                {resource.topic && <span>• {resource.topic}</span>}
              </div>
              {resource.fileUrl ? (
                <a
                  href={resource.fileUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block w-full py-2 text-center rounded-xl bg-secondary-50 text-secondary-600 font-semibold text-sm hover:bg-secondary-100 transition-colors"
                >
                  View Resource →
                </a>
              ) : (
                <span className="block w-full py-2 text-center rounded-xl bg-slate-50 text-slate-400 font-semibold text-sm cursor-default">
                  No link attached
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
