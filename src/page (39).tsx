"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface AttendanceRow {
  id: string;
  date: string;
  isPresent: boolean;
  learnerFirstName: string;
  learnerLastName: string;
  className: string;
  note: string | null;
}

export default function AdminAttendancePage() {
  const [records, setRecords] = useState<AttendanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);

  useEffect(() => { loadData(); }, [date]);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch(`/api/attendance?date=${date}`, { headers: { Authorization: `Bearer ${token}` } });
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
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Attendance Records</h1>
        <p className="text-sm text-slate-500">View attendance recorded by teachers</p>
      </div>

      {/* Date selector + stats */}
      <div className="grid md:grid-cols-4 gap-4 mb-6">
        <div className="md:col-span-1 bg-white rounded-2xl p-5 border border-slate-100">
          <label className="block text-sm font-medium text-slate-700 mb-1">Select Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <p className="text-3xl font-bold text-slate-800">{present}</p>
          <p className="text-sm text-slate-500">Present</p>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <p className="text-3xl font-bold text-red-500">{absent}</p>
          <p className="text-sm text-slate-500">Absent</p>
        </div>
        <div className="bg-white rounded-2xl p-5 border border-slate-100">
          <p className="text-3xl font-bold text-green-600">{rate}%</p>
          <p className="text-sm text-slate-500">Attendance Rate</p>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : records.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">✅</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No attendance for this date</h3>
          <p className="text-slate-500 text-sm">Teachers need to mark attendance for this date</p>
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-lg text-slate-800">Attendance for {new Date(date).toLocaleDateString()}</h2>
          </div>
          <div className="divide-y divide-slate-100">
            {records.map((r) => (
              <div key={r.id} className="p-4 flex items-center gap-4">
                <div className={`w-11 h-11 rounded-xl flex items-center justify-center font-bold text-sm ${
                  r.isPresent ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
                }`}>
                  {r.learnerFirstName?.[0]}{r.learnerLastName?.[0]}
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-slate-700">{r.learnerFirstName} {r.learnerLastName}</p>
                  <p className="text-xs text-slate-400">{r.className}</p>
                </div>
                <span className={`px-3 py-1.5 rounded-full text-xs font-semibold ${
                  r.isPresent ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"
                }`}>
                  {r.isPresent ? "✓ Present" : "✗ Absent"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
