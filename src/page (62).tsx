"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface AttendanceRow {
  id: string;
  date: string;
  isPresent: boolean;
  note: string | null;
  className: string;
}

export default function ParentAttendancePage() {
  const [children, setChildren] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [records, setRecords] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) loadChildren(data.data.user.id);
      });
  }, []);

  async function loadChildren(parentId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/parent-learners?parentId=${parentId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) {
        const learnerIds = data.data.map((c: { learnerId: string }) => c.learnerId);
        const userRes = await fetch("/api/users?role=learner&limit=100", { headers: { Authorization: `Bearer ${token}` } });
        const userData = await userRes.json();
        if (userData.success) {
          const kids = userData.data.users.filter((l: { id: string }) => learnerIds.includes(l.id));
          setChildren(kids);
          if (kids.length > 0) loadAttendance(kids[0].id);
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function loadAttendance(learnerId: string) {
    setChildId(learnerId);
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance?learnerId=${learnerId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setRecords(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const present = records.filter((r) => r.isPresent).length;
  const absent = records.length - present;
  const rate = records.length > 0 ? Math.round((present / records.length) * 100) : 0;

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Attendance</h1>
        <p className="text-sm text-slate-500">Monitor your child&apos;s school attendance</p>
      </div>

      {children.length > 0 && (
        <div className="mb-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-4">
          <label className="block text-sm font-medium text-slate-700 mb-2">Select Child</label>
          <select value={childId || ""} onChange={(e) => loadAttendance(e.target.value)}
            className="w-full max-w-sm px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
            {children.map((c) => (
              <option key={c.id} value={c.id}>{c.firstName} {c.lastName}</option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-24 bg-slate-200 rounded-2xl" />
          <div className="h-64 bg-slate-200 rounded-2xl" />
        </div>
      ) : children.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700">No children linked</h3>
        </div>
      ) : (
        <>
          <div className="grid md:grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-2xl p-6 border border-slate-100">
              <p className="text-3xl font-bold text-green-600">{present}</p>
              <p className="text-sm text-slate-500">Days Present</p>
            </div>
            <div className="bg-white rounded-2xl p-6 border border-slate-100">
              <p className="text-3xl font-bold text-red-500">{absent}</p>
              <p className="text-sm text-slate-500">Days Absent</p>
            </div>
            <div className="bg-gradient-to-br from-purple-500 to-purple-700 rounded-2xl p-6 text-white">
              <p className="text-3xl font-bold">{rate}%</p>
              <p className="text-purple-100 text-sm">Attendance Rate</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-slate-100">
            <div className="p-4 border-b border-slate-100">
              <h2 className="font-bold text-lg text-slate-800">Attendance History</h2>
            </div>
            {records.length === 0 ? (
              <div className="p-8 text-center text-slate-500">No attendance records yet</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {records.map((r) => (
                  <div key={r.id} className="p-4 flex items-center gap-4">
                    <span className={`w-3 h-3 rounded-full ${r.isPresent ? "bg-green-500" : "bg-red-500"}`} />
                    <div className="flex-1">
                      <p className="font-medium text-slate-700">{new Date(r.date).toLocaleDateString()}</p>
                      <p className="text-xs text-slate-400">{r.className}</p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${r.isPresent ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"}`}>
                      {r.isPresent ? "✓ Present" : "✗ Absent"}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </DashboardShell>
  );
}
