"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { teacherNav } from "@/lib/teacher-nav";

interface Learner {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface ClassRow {
  id: string;
  name: string;
}

export default function TeacherAttendancePage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [learners, setLearners] = useState<Learner[]>([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [date, setDate] = useState(new Date().toISOString().split("T")[0]);
  const [records, setRecords] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => { loadClasses(); }, []);

  async function loadClasses() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setClasses(data.data);
    } catch (err) {
      console.error(err);
    }
  }

  async function loadLearners() {
    if (!selectedClass) return;
    const token = localStorage.getItem("el_token");
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/attendance", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classId: selectedClass }),
      });
      const data = await res.json();
      if (data.success) {
        setLearners(data.data);
        // Default all to present
        const defaults: Record<string, boolean> = {};
        data.data.forEach((l: Learner) => { defaults[l.id] = true; });
        setRecords(defaults);

        // Load existing attendance for this date
        const attRes = await fetch(`/api/attendance?classId=${selectedClass}&date=${date}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const attData = await attRes.json();
        if (attData.success && attData.data.length > 0) {
          const existing: Record<string, boolean> = {};
          attData.data.forEach((r: { learnerId: string; isPresent: boolean }) => {
            existing[r.learnerId] = r.isPresent;
          });
          setRecords(existing);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    const token = localStorage.getItem("el_token");
    setSaving(true);
    setMessage("");
    try {
      const attendanceRecords = Object.entries(records).map(([learnerId, isPresent]) => ({
        learnerId, isPresent,
      }));
      const res = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classId: selectedClass, date, records: attendanceRecords }),
      });
      const data = await res.json();
      if (data.success) {
        setMessage("✅ Attendance saved successfully!");
      } else {
        setMessage(`❌ ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      setMessage("❌ Failed to save attendance");
    } finally {
      setSaving(false);
    }
  }

  const present = Object.values(records).filter((v) => v).length;

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Take Attendance</h1>
        <p className="text-sm text-slate-500">Mark learner attendance for your classes</p>
      </div>

      {/* Selector */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
        <div className="grid md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Class</label>
            <select value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
              <option value="">Select class</option>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
          </div>
          <div className="flex items-end">
            <button onClick={loadLearners} disabled={!selectedClass}
              className="w-full py-3 rounded-xl gradient-secondary text-white font-semibold disabled:opacity-50">
              {loading ? "Loading..." : "Load Students"}
            </button>
          </div>
        </div>
      </div>

      {message && (
        <div className={`mb-4 p-4 rounded-xl text-sm ${message.startsWith("✅") ? "bg-green-50 border border-green-200 text-green-700" : "bg-red-50 border border-red-200 text-red-700"}`}>
          {message}
        </div>
      )}

      {learners.length > 0 && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            <div className="bg-white rounded-2xl p-5 border border-slate-100">
              <p className="text-3xl font-bold text-slate-800">{present}</p>
              <p className="text-sm text-slate-500">Present</p>
            </div>
            <div className="bg-white rounded-2xl p-5 border border-slate-100">
              <p className="text-3xl font-bold text-red-500">{learners.length - present}</p>
              <p className="text-sm text-slate-500">Absent</p>
            </div>
            <div className="bg-white rounded-2xl p-5 border border-slate-100">
              <p className="text-3xl font-bold text-green-600">{learners.length > 0 ? Math.round((present / learners.length) * 100) : 0}%</p>
              <p className="text-sm text-slate-500">Rate</p>
            </div>
          </div>

          {/* Mark all buttons */}
          <div className="flex gap-3 mb-4">
            <button onClick={() => {
              const all: Record<string, boolean> = {};
              learners.forEach((l) => { all[l.id] = true; });
              setRecords(all);
            }} className="px-4 py-2 rounded-xl bg-green-100 text-green-600 text-sm font-semibold hover:bg-green-200">
              ✓ Mark All Present
            </button>
            <button onClick={() => {
              const all: Record<string, boolean> = {};
              learners.forEach((l) => { all[l.id] = false; });
              setRecords(all);
            }} className="px-4 py-2 rounded-xl bg-red-100 text-red-600 text-sm font-semibold hover:bg-red-200">
              ✗ Mark All Absent
            </button>
          </div>

          {/* Student list */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden mb-6">
            <div className="p-4 border-b border-slate-100">
              <h2 className="font-bold text-lg text-slate-800">Students ({learners.length})</h2>
            </div>
            <div className="divide-y divide-slate-100">
              {learners.map((learner) => (
                <div key={learner.id} className="p-4 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-xl bg-secondary-100 flex items-center justify-center text-secondary-600 font-bold text-sm">
                    {learner.firstName?.[0]}{learner.lastName?.[0]}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-slate-700">{learner.firstName} {learner.lastName}</p>
                    <p className="text-xs text-slate-400">{learner.email}</p>
                  </div>
                  <button
                    onClick={() => setRecords({ ...records, [learner.id]: true })}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      records[learner.id] ? "bg-green-500 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    ✓ Present
                  </button>
                  <button
                    onClick={() => setRecords({ ...records, [learner.id]: false })}
                    className={`px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                      records[learner.id] === false ? "bg-red-500 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                    }`}
                  >
                    ✗ Absent
                  </button>
                </div>
              ))}
            </div>
          </div>

          <button onClick={handleSave} disabled={saving}
            className="w-full py-4 rounded-xl gradient-secondary text-white font-bold text-lg shadow-lg hover:shadow-xl transition-all disabled:opacity-50">
            {saving ? "Saving..." : "Save Attendance ✅"}
          </button>
        </>
      )}
    </DashboardShell>
  );
}
