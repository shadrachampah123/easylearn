"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface Announcement {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  authorFirstName: string;
  authorLastName: string;
  createdAt: string;
}

export default function ParentAnnouncementsPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/announcements", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => { if (data.success) setAnnouncements(data.data); })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Announcements</h1>
        <p className="text-sm text-slate-500">School announcements and updates</p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : announcements.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📢</div>
          <h3 className="text-lg font-semibold text-slate-700">No announcements</h3>
        </div>
      ) : (
        <div className="space-y-3">
          {announcements.map((a) => (
            <div key={a.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-center gap-3 mb-2">
                <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
                {a.isPinned && <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 text-xs font-semibold">📌</span>}
              </div>
              <p className="text-slate-600 text-sm mb-3 whitespace-pre-wrap">{a.content}</p>
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
