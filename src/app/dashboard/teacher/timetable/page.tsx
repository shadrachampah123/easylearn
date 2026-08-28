"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { teacherNav } from "@/lib/teacher-nav";
import TimetableGrid, { type TimetableEntry } from "@/components/dashboard/TimetableGrid";

export default function TeacherTimetablePage() {
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadTimetable() {
    setLoading(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/timetable", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setEntries(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTimetable();
  }, []);

  const periods = entries.length;

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Class Timetable</h1>
        <p className="text-sm text-slate-500">
          {loading ? "Loading your schedule..." : `${periods} period${periods === 1 ? "" : "s"} on your weekly schedule`}
        </p>
      </div>

      {!loading && periods === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📅</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No timetable yet</h3>
          <p className="text-slate-500 text-sm">Your teaching schedule will appear here once the school administrator publishes it.</p>
        </div>
      ) : (
        <TimetableGrid
          entries={entries}
          loading={loading}
          showClass
          emptyMessage="No periods scheduled for your classes yet."
        />
      )}
    </DashboardShell>
  );
}
