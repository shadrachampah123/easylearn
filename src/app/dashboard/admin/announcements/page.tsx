"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface Announcement {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  isPublic: boolean;
  authorFirstName: string;
  authorLastName: string;
  createdAt: string;
}

export default function AdminAnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formData, setFormData] = useState({ title: "", content: "", isPinned: false, isPublic: true });

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/announcements", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setAnnouncements(data.data);
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
      const res = await fetch("/api/announcements", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (data.success) {
        setShowCreate(false);
        setFormData({ title: "", content: "", isPinned: false, isPublic: true });
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

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Announcements</h1>
          <p className="text-sm text-slate-500">Post announcements for the whole school or specific groups</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + New Announcement
        </button>
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">New Announcement</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Title *</label>
                <input type="text" required value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="e.g., Mid-term Exams Schedule"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Content *</label>
                <textarea required value={formData.content}
                  onChange={(e) => setFormData({ ...formData, content: e.target.value })}
                  rows={5}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none" />
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={formData.isPublic}
                    onChange={(e) => setFormData({ ...formData, isPublic: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300" />
                  Public announcement
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={formData.isPinned}
                    onChange={(e) => setFormData({ ...formData, isPinned: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300" />
                  📌 Pin announcement
                </label>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Posting..." : "Post Announcement"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : announcements.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📢</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No announcements yet</h3>
          <button onClick={() => setShowCreate(true)} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Post Announcement</button>
        </div>
      ) : (
        <div className="space-y-3">
          {announcements.map((a) => (
            <div key={a.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
                {a.isPinned && <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 text-xs font-semibold">📌 Pinned</span>}
                {a.isPublic && <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-600 text-xs font-semibold">Public</span>}
              </div>
              <p className="text-slate-600 text-sm mb-3 line-clamp-3">{a.content}</p>
              <div className="flex items-center gap-3 text-xs text-slate-400">
                <span>👤 {a.authorFirstName} {a.authorLastName}</span>
                <span>•</span>
                <span>📅 {new Date(a.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
