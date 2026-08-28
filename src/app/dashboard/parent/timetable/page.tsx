"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";
import TimetableGrid, { type TimetableEntry } from "@/components/dashboard/TimetableGrid";

export default function ParentTimetablePage() {
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

  const classNames = Array.from(
    new Set(entries.map((entry) => entry.className).filter(Boolean))
  ) as string[];

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">School Timetable</h1>
        <p className="text-sm text-slate-500">
          Weekly class schedule for your child
          {classNames.length > 0 ? ` • ${classNames.join(", ")}` : ""}
        </p>
      </div>

      {!loading && entries.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📅</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No timetable yet</h3>
          <p className="text-slate-500 text-sm">Your child&apos;s class schedule will appear here once the school publishes it.</p>
        </div>
      ) : (
        <TimetableGrid entries={entries} loading={loading} showClass />
      )}
    </DashboardShell>
  );
}
