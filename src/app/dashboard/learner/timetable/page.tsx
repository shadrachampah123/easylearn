"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { learnerNav } from "@/lib/learner-nav";
import TimetableGrid, { type TimetableEntry } from "@/components/dashboard/TimetableGrid";
import { apiFetch } from "../../../../lib/api-client";

export default function LearnerTimetablePage() {
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadTimetable() {
    setLoading(true);
    try {
      const res = await apiFetch("/api/timetable");
      const data = await res.json();
      if (data.success) setEntries(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Network results update this page\'s data/loading state after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadTimetable();
  }, []);

  const periods = entries.length;

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Timetable</h1>
        <p className="text-sm text-slate-500">
          {loading ? "Loading your weekly schedule..." : `${periods} period${periods === 1 ? "" : "s"} scheduled this week`}
        </p>
      </div>

      {!loading && periods === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📅</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No timetable yet</h3>
          <p className="text-slate-500 text-sm">Your class schedule will appear here once your school publishes it.</p>
        </div>
      ) : (
        <TimetableGrid entries={entries} loading={loading} />
      )}
    </DashboardShell>
  );
}
