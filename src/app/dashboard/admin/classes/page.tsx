"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface ClassRow {
  id: string;
  name: string;
  level: string;
  capacity: number | null;
  classTeacherId: string | null;
}

interface UserRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

interface ClassForm {
  name: string;
  level: string;
  capacity: number;
  classTeacherId: string;
}

const emptyClassForm: ClassForm = {
  name: "",
  level: "primary",
  capacity: 40,
  classTeacherId: "",
};

export default function AdminClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teachers, setTeachers] = useState<UserRow[]>([]);
  const [learners, setLearners] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showClassForm, setShowClassForm] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [editing, setEditing] = useState<ClassRow | null>(null);
  const [enrollClass, setEnrollClass] = useState<ClassRow | null>(null);
  const [selectedLearner, setSelectedLearner] = useState("");
  const [classForm, setClassForm] = useState<ClassForm>(emptyClassForm);
  const [saving, setSaving] = useState(false);
  const [enrollMessage, setEnrollMessage] = useState("");

  useEffect(() => {
    void loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [classResponse, teacherResponse, learnerResponse] = await Promise.all([
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/users?role=teacher", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/users?role=learner", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const classData = await classResponse.json();
      const teacherData = await teacherResponse.json();
      const learnerData = await learnerResponse.json();
      if (classData.success) setClasses(classData.data);
      if (teacherData.success) setTeachers(teacherData.data.users);
      if (learnerData.success) setLearners(learnerData.data.users);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function openCreate() {
    setEditing(null);
    setClassForm(emptyClassForm);
    setShowClassForm(true);
  }

  function openEdit(classRow: ClassRow) {
    setEditing(classRow);
    setClassForm({
      name: classRow.name,
      level: classRow.level,
      capacity: classRow.capacity || 40,
      classTeacherId: classRow.classTeacherId || "",
    });
    setShowClassForm(true);
  }

  function closeClassForm() {
    setShowClassForm(false);
    setEditing(null);
    setClassForm(emptyClassForm);
  }

  async function handleClassSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");

    try {
      const response = await fetch(editing ? `/api/classes/${editing.id}` : "/api/classes", {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: classForm.name.trim(),
          level: classForm.level,
          capacity: Math.max(1, classForm.capacity),
          classTeacherId: classForm.classTeacherId || null,
        }),
      });
      const data = await response.json();

      if (!data.success) {
        alert(data.error || "Could not save the class");
        return;
      }

      closeClassForm();
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not save the class. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(classRow: ClassRow) {
    if (!confirm(`Delete ${classRow.name}? Its enrollments, timetable periods, attendance records, assignments, and quizzes will also be removed.`)) return;

    const token = localStorage.getItem("el_token");
    setSaving(true);
    try {
      const response = await fetch(`/api/classes/${classRow.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (!data.success) {
        alert(data.error || "Could not delete the class");
        return;
      }
      await loadData();
    } catch (err) {
      console.error(err);
      alert("Could not delete the class. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleEnroll(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enrollClass || !selectedLearner) return;
    setSaving(true);
    setEnrollMessage("");
    const token = localStorage.getItem("el_token");
    try {
      const response = await fetch("/api/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ learnerId: selectedLearner, classId: enrollClass.id }),
      });
      const data = await response.json();
      if (data.success) {
        setEnrollMessage("✅ Learner enrolled successfully!");
        setSelectedLearner("");
      } else {
        setEnrollMessage(`❌ ${data.error}`);
      }
    } catch (err) {
      console.error(err);
      setEnrollMessage("❌ Failed to enroll");
    } finally {
      setSaving(false);
    }
  }

  async function handleAssignTeacher(classId: string, teacherId: string) {
    const token = localStorage.getItem("el_token");
    try {
      const response = await fetch(`/api/classes/${classId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classTeacherId: teacherId }),
      });
      const data = await response.json();
      if (data.success) await loadData();
      else alert(data.error || "Could not update the class teacher");
    } catch (err) {
      console.error(err);
    }
  }

  const levelColors: Record<string, string> = {
    nursery: "bg-pink-100 text-pink-600",
    kindergarten: "bg-yellow-100 text-yellow-600",
    primary: "bg-blue-100 text-blue-600",
    junior_high: "bg-green-100 text-green-600",
  };

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Classes</h1>
          <p className="text-sm text-slate-500">Manage classes, assign teachers, and enroll learners</p>
        </div>
        <button type="button" onClick={openCreate} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + Create Class
        </button>
      </div>

      {showClassForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">{editing ? "Edit Class" : "Create Class"}</h2>
              <button type="button" onClick={closeClassForm} disabled={saving} className="text-slate-400 hover:text-slate-600 text-2xl disabled:opacity-50">&times;</button>
            </div>
            <form onSubmit={handleClassSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="class-name">Class Name *</label>
                <input
                  id="class-name"
                  type="text"
                  required
                  value={classForm.name}
                  onChange={(event) => setClassForm({ ...classForm, name: event.target.value })}
                  placeholder="e.g., Primary 4"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="class-level">Level *</label>
                <select
                  id="class-level"
                  value={classForm.level}
                  onChange={(event) => setClassForm({ ...classForm, level: event.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                >
                  <option value="nursery">Nursery</option>
                  <option value="kindergarten">Kindergarten</option>
                  <option value="primary">Primary</option>
                  <option value="junior_high">Junior High</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="class-capacity">Capacity</label>
                <input
                  id="class-capacity"
                  type="number"
                  min={1}
                  value={classForm.capacity}
                  onChange={(event) => setClassForm({ ...classForm, capacity: Number(event.target.value) || 1 })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="class-teacher">Class Teacher</label>
                <select
                  id="class-teacher"
                  value={classForm.classTeacherId}
                  onChange={(event) => setClassForm({ ...classForm, classTeacherId: event.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm focus:ring-2 focus:ring-primary-500"
                >
                  <option value="">None</option>
                  {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.firstName} {teacher.lastName}</option>)}
                </select>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={closeClassForm} disabled={saving} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold disabled:opacity-50">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : editing ? "Save Changes" : "Create Class"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEnroll && enrollClass && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Enroll Learner in {enrollClass.name}</h2>
              <button type="button" onClick={() => setShowEnroll(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleEnroll} className="p-6 space-y-4">
              {enrollMessage && <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-sm">{enrollMessage}</div>}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1" htmlFor="learner-select">Select Learner</label>
                <select id="learner-select" value={selectedLearner} onChange={(event) => setSelectedLearner(event.target.value)} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="">Choose a learner...</option>
                  {learners.map((learner) => <option key={learner.id} value={learner.id}>{learner.firstName} {learner.lastName} ({learner.email})</option>)}
                </select>
              </div>
              <button type="submit" disabled={saving || !selectedLearner} className="w-full py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                {saving ? "Enrolling..." : "Enroll Learner"}
              </button>
            </form>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((item) => (
            <div key={item} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/2 mb-3" /><div className="h-4 bg-slate-100 rounded w-3/4" /></div>
          ))}
        </div>
      ) : classes.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">🏫</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No classes created</h3>
          <button type="button" onClick={openCreate} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Create First Class</button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {classes.map((classRow) => (
            <div key={classRow.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-start justify-between mb-4 gap-3">
                <div>
                  <h3 className="font-bold text-lg text-slate-800">{classRow.name}</h3>
                  <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-semibold ${levelColors[classRow.level] || "bg-slate-100 text-slate-600"}`}>
                    {classRow.level.replace("_", " ").toUpperCase()}
                  </span>
                </div>
                <span className="text-xs text-slate-400 whitespace-nowrap">Capacity: {classRow.capacity}</span>
              </div>

              <div className="space-y-2 mb-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 w-24" htmlFor={`teacher-${classRow.id}`}>Teacher:</label>
                  <select
                    id={`teacher-${classRow.id}`}
                    value={classRow.classTeacherId || ""}
                    onChange={(event) => void handleAssignTeacher(classRow.id, event.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm"
                  >
                    <option value="">None</option>
                    {teachers.map((teacher) => <option key={teacher.id} value={teacher.id}>{teacher.firstName} {teacher.lastName}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex gap-2 mb-2">
                <button type="button" onClick={() => openEdit(classRow)} className="flex-1 py-2.5 rounded-xl bg-primary-50 text-primary-700 font-semibold text-sm hover:bg-primary-100 transition-colors">Edit</button>
                <button type="button" onClick={() => void handleDelete(classRow)} disabled={saving} className="flex-1 py-2.5 rounded-xl bg-red-50 text-red-600 font-semibold text-sm hover:bg-red-100 transition-colors disabled:opacity-50">Delete</button>
              </div>
              <button
                type="button"
                onClick={() => { setEnrollClass(classRow); setShowEnroll(true); setEnrollMessage(""); }}
                className="w-full py-2.5 rounded-xl bg-blue-50 text-blue-600 font-semibold text-sm hover:bg-blue-100 transition-colors"
              >
                + Enroll Learner
              </button>
            </div>
          ))}
        </div>
      )}
    </DashboardShell>
  );
}
