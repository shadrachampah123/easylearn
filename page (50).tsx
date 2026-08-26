"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { learnerNav } from "@/lib/learner-nav";

interface Announcement {
  id: string;
  title: string;
  content: string;
  isPinned: boolean;
  authorFirstName: string;
  authorLastName: string;
  createdAt: string;
}

export default function LearnerAnnouncementsPage() {
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

  const pinned = announcements.filter((a) => a.isPinned);
  const regular = announcements.filter((a) => !a.isPinned);

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Announcements</h1>
        <p className="text-sm text-slate-500">Important updates from your school</p>
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
          <h3 className="text-lg font-semibold text-slate-700">No announcements yet</h3>
        </div>
      ) : (
        <div className="space-y-6">
          {pinned.length > 0 && (
            <div>
              <h2 className="font-bold text-slate-700 mb-3 flex items-center gap-2">📌 Pinned</h2>
              <div className="space-y-3">
                {pinned.map((a) => <AnnouncementCard key={a.id} a={a} pinned />)}
              </div>
            </div>
          )}
          {regular.length > 0 && (
            <div className="space-y-3">
              {regular.map((a) => <AnnouncementCard key={a.id} a={a} />)}
            </div>
          )}
        </div>
      )}
    </DashboardShell>
  );
}

function AnnouncementCard({ a, pinned }: { a: Announcement; pinned?: boolean }) {
  return (
    <div className={`p-6 rounded-2xl bg-white shadow-sm border-2 transition-all hover:shadow-md ${
      pinned ? "border-yellow-200 bg-yellow-50/50" : "border-slate-100"
    }`}>
      <div className="flex items-center gap-3 mb-2">
        <h3 className="font-bold text-lg text-slate-800">{a.title}</h3>
        {pinned && <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-600 text-xs font-semibold">📌 Pinned</span>}
      </div>
      <p className="text-slate-600 text-sm mb-3 whitespace-pre-wrap">{a.content}</p>
      <div className="flex items-center gap-3 text-xs text-slate-400">
        <span>👤 {a.authorFirstName} {a.authorLastName}</span>
        <span>•</span>
        <span>📅 {new Date(a.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
