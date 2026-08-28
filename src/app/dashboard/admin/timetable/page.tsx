"use client";

import { useCallback, useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";
import TimetableGrid, {
  TIMETABLE_DAYS,
  type DayValue,
  type TimetableEntry,
} from "@/components/dashboard/TimetableGrid";

interface Option {
  id: string;
  name: string;
}

interface FormState {
  classId: string;
  subjectId: string;
  teacherId: string;
  dayOfWeek: DayValue;
  startTime: string;
  endTime: string;
  room: string;
  notes: string;
}

const emptyForm: FormState = {
  classId: "",
  subjectId: "",
  teacherId: "",
  dayOfWeek: "monday",
  startTime: "07:30",
  endTime: "08:30",
  room: "",
  notes: "",
};

export default function AdminTimetablePage() {
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [classes, setClasses] = useState<Option[]>([]);
  const [subjects, setSubjects] = useState<Option[]>([]);
  const [teachers, setTeachers] = useState<Option[]>([]);
  const [classFilter, setClassFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<TimetableEntry | null>(null);
  const [formData, setFormData] = useState<FormState>(emptyForm);

  const loadOptions = useCallback(async () => {
    const token = localStorage.getItem("el_token");
    const headers = { Authorization: `Bearer ${token}` };

    try {
      const [classRes, subjectRes, teacherRes] = await Promise.all([
        fetch("/api/classes", { headers }),
        fetch("/api/subjects", { headers }),
        fetch("/api/users?role=teacher&limit=100", { headers }),
      ]);

      const [classData, subjectData, teacherData] = await Promise.all([
        classRes.json(),
        subjectRes.json(),
        teacherRes.json(),
      ]);

      if (classData.success) {
        setClasses(classData.data.map((c: { id: string; name: string }) => ({ id: c.id, name: c.name })));
      }
      if (subjectData.success) {
        setSubjects(subjectData.data.map((s: { id: string; name: string }) => ({ id: s.id, name: s.name })));
      }
      if (teacherData.success) {
        setTeachers(
          teacherData.data.map((t: { id: string; firstName: string; lastName: string }) => ({
            id: t.id,
            name: `${t.firstName} ${t.lastName}`,
          }))
        );
      }
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadTimetable = useCallback(async () => {
    setLoading(true);
    const token = localStorage.getItem("el_token");
    const url = classFilter ? `/api/timetable?classId=${classFilter}` : "/api/timetable";

    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setEntries(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [classFilter]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  useEffect(() => {
    loadTimetable();
  }, [loadTimetable]);

  function openCreate(day?: DayValue) {
    setEditing(null);
    setFormData({
      ...emptyForm,
      dayOfWeek: day ?? "monday",
      classId: classFilter || classes[0]?.id || "",
    });
    setShowForm(true);
  }

  function openEdit(entry: TimetableEntry) {
    setEditing(entry);
    setFormData({
      classId: entry.classId,
      subjectId: entry.subjectId ?? "",
      teacherId: entry.teacherId ?? "",
      dayOfWeek: entry.dayOfWeek,
      startTime: entry.startTime.slice(0, 5),
      endTime: entry.endTime.slice(0, 5),
      room: entry.room ?? "",
      notes: entry.notes ?? "",
    });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);

    const token = localStorage.getItem("el_token");

    try {
      const res = await fetch(editing ? `/api/timetable/${editing.id}` : "/api/timetable", {
        method: editing ? "PUT" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          classId: formData.classId,
          subjectId: formData.subjectId || null,
          teacherId: formData.teacherId || null,
          dayOfWeek: formData.dayOfWeek,
          startTime: formData.startTime,
          endTime: formData.endTime,
          room: formData.room || null,
          notes: formData.notes || null,
        }),
      });

      const data = await res.json();
      if (data.success) {
        setShowForm(false);
        setEditing(null);
        await loadTimetable();
      } else {
        alert(data.error || "Could not save the period");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(entry: TimetableEntry) {
    if (!confirm(`Delete ${entry.subjectName || "this period"} on ${entry.dayOfWeek}?`)) return;

    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/timetable/${entry.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        await loadTimetable();
      } else {
        alert(data.error || "Could not delete the period");
      }
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">School Timetable</h1>
          <p className="text-sm text-slate-500">
            {loading ? "Loading the school schedule..." : `${entries.length} period${entries.length === 1 ? "" : "s"} scheduled`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-600 outline-none focus:ring-2 focus:ring-primary-500"
          >
            <option value="">All classes</option>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          <button
            onClick={() => openCreate()}
            className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all flex items-center gap-2"
          >
            <span>+</span> Add Period
          </button>
        </div>
      </div>

      <TimetableGrid
        entries={entries}
        loading={loading}
        showClass
        onEdit={openEdit}
        onDelete={handleDelete}
        onAdd={() => openCreate()}
        emptyMessage="No periods scheduled for the selected class yet."
      />

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-xl max-h-[90vh] overflow-y-auto">
            <div className="p-6 border-b border-slate-100">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-slate-800">
                  {editing ? "Edit Period" : "Add Period"}
                </h2>
                <button
                  onClick={() => setShowForm(false)}
                  className="text-slate-400 hover:text-slate-600 text-2xl"
                >
                  &times;
                </button>
              </div>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Class *</label>
                <select
                  required
                  value={formData.classId}
                  onChange={(e) => setFormData({ ...formData, classId: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                >
                  <option value="">Select class</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subject</label>
                  <select
                    value={formData.subjectId}
                    onChange={(e) => setFormData({ ...formData, subjectId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  >
                    <option value="">No subject</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Teacher</label>
                  <select
                    value={formData.teacherId}
                    onChange={(e) => setFormData({ ...formData, teacherId: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  >
                    <option value="">Unassigned</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Day *</label>
                <select
                  value={formData.dayOfWeek}
                  onChange={(e) => setFormData({ ...formData, dayOfWeek: e.target.value as DayValue })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                >
                  {TIMETABLE_DAYS.map((day) => (
                    <option key={day.value} value={day.value}>{day.label}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start time *</label>
                  <input
                    type="time"
                    required
                    value={formData.startTime}
                    onChange={(e) => setFormData({ ...formData, startTime: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End time *</label>
                  <input
                    type="time"
                    required
                    value={formData.endTime}
                    onChange={(e) => setFormData({ ...formData, endTime: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Room</label>
                <input
                  type="text"
                  value={formData.room}
                  onChange={(e) => setFormData({ ...formData, room: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none"
                  placeholder="e.g., Rm 12, Lab 1"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                  rows={2}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-primary-500 focus:border-transparent outline-none resize-none"
                  placeholder="Optional notes"
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowForm(false)}
                  className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold shadow-lg disabled:opacity-50"
                >
                  {saving ? "Saving..." : editing ? "Update Period" : "Add Period"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
