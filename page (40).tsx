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

export default function AdminClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [teachers, setTeachers] = useState<UserRow[]>([]);
  const [learners, setLearners] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [enrollClass, setEnrollClass] = useState<ClassRow | null>(null);
  const [selectedLearner, setSelectedLearner] = useState("");
  const [createForm, setCreateForm] = useState({ name: "", level: "primary", capacity: 40, classTeacherId: "" });
  const [saving, setSaving] = useState(false);
  const [enrollMessage, setEnrollMessage] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [classRes, teacherRes, learnerRes] = await Promise.all([
        fetch("/api/classes", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/users?role=teacher", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/users?role=learner", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const classData = await classRes.json();
      const teacherData = await teacherRes.json();
      const learnerData = await learnerRes.json();
      if (classData.success) setClasses(classData.data);
      if (teacherData.success) setTeachers(teacherData.data.users);
      if (learnerData.success) setLearners(learnerData.data.users);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(createForm),
      });
      const data = await res.json();
      if (data.success) {
        setShowCreate(false);
        setCreateForm({ name: "", level: "primary", capacity: 40, classTeacherId: "" });
        loadData();
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  async function handleEnroll(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollClass || !selectedLearner) return;
    setSaving(true);
    setEnrollMessage("");
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/enrollments", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ learnerId: selectedLearner, classId: enrollClass.id }),
      });
      const data = await res.json();
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
      await fetch(`/api/classes/${classId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ classTeacherId: teacherId }),
      });
      loadData();
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
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Classes</h1>
          <p className="text-sm text-slate-500">Manage classes, assign teachers, and enroll learners</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl hover:scale-105 transition-all">
          + Create Class
        </button>
      </div>

      {/* Create Class Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Create Class</h2>
              <button onClick={() => setShowCreate(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Class Name *</label>
                <input type="text" required value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder="e.g., Primary 4"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Level *</label>
                <select value={createForm.level}
                  onChange={(e) => setCreateForm({ ...createForm, level: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="nursery">Nursery</option>
                  <option value="kindergarten">Kindergarten</option>
                  <option value="primary">Primary</option>
                  <option value="junior_high">Junior High</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Capacity</label>
                <input type="number" value={createForm.capacity}
                  onChange={(e) => setCreateForm({ ...createForm, capacity: parseInt(e.target.value) || 40 })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Class Teacher</label>
                <select value={createForm.classTeacherId}
                  onChange={(e) => setCreateForm({ ...createForm, classTeacherId: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="">None</option>
                  {teachers.map((t) => (
                    <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Creating..." : "Create Class"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Enroll Modal */}
      {showEnroll && enrollClass && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Enroll Learner in {enrollClass.name}</h2>
              <button onClick={() => setShowEnroll(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleEnroll} className="p-6 space-y-4">
              {enrollMessage && (
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 text-sm">{enrollMessage}</div>
              )}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Select Learner</label>
                <select value={selectedLearner} onChange={(e) => setSelectedLearner(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="">Choose a learner...</option>
                  {learners.map((l) => (
                    <option key={l.id} value={l.id}>{l.firstName} {l.lastName} ({l.email})</option>
                  ))}
                </select>
              </div>
              <button type="submit" disabled={saving || !selectedLearner} className="w-full py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                {saving ? "Enrolling..." : "Enroll Learner"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Classes List */}
      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/2 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : classes.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">🏫</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No classes created</h3>
          <button onClick={() => setShowCreate(true)} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">
            Create First Class
          </button>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {classes.map((cls) => (
            <div key={cls.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="font-bold text-lg text-slate-800">{cls.name}</h3>
                  <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-semibold ${levelColors[cls.level] || "bg-slate-100 text-slate-600"}`}>
                    {cls.level.replace("_", " ").toUpperCase()}
                  </span>
                </div>
                <span className="text-xs text-slate-400">Capacity: {cls.capacity}</span>
              </div>

              <div className="space-y-2 mb-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-slate-500 w-24">Teacher:</label>
                  <select
                    value={cls.classTeacherId || ""}
                    onChange={(e) => handleAssignTeacher(cls.id, e.target.value)}
                    className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm"
                  >
                    <option value="">None</option>
                    {teachers.map((t) => (
                      <option key={t.id} value={t.id}>{t.firstName} {t.lastName}</option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                onClick={() => { setEnrollClass(cls); setShowEnroll(true); setEnrollMessage(""); }}
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
