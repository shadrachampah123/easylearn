"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";
import { teacherNav } from "@/lib/teacher-nav";

interface TeacherClass {
  id: string;
  classId: string;
  className: string;
  classLevel: string;
  subjectName: string;
  createdAt: string;
}

interface Enrollment {
  id: string;
  learnerFirstName: string;
  learnerLastName: string;
  learnerEmail: string;
  className: string;
}

export default function TeacherClassesPage() {
  const [classes, setClasses] = useState<TeacherClass[]>([]);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [selectedClass, setSelectedClass] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/teacher-classes", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setClasses(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  async function loadEnrollments(classId: string) {
    setSelectedClass(classId);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/enrollments?classId=${classId}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setEnrollments(data.data);
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Classes</h1>
        <p className="text-sm text-slate-500">Classes and subjects assigned to you</p>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        {/* Assigned Classes */}
        <div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
              ))}
            </div>
          ) : classes.length === 0 ? (
            <div className="text-center py-12 bg-white rounded-2xl shadow-sm border border-slate-100">
              <div className="text-6xl mb-4">🏫</div>
              <h3 className="text-lg font-semibold text-slate-700 mb-2">No classes assigned</h3>
              <p className="text-slate-500 text-sm">Contact your administrator to assign you to classes</p>
            </div>
          ) : (
            <div className="space-y-3">
              {classes.map((cls) => (
                <button
                  key={cls.id}
                  onClick={() => loadEnrollments(cls.classId || selectedClass)}
                  className={`w-full p-5 rounded-2xl bg-white shadow-sm border-2 text-left transition-all hover:shadow-md ${
                    selectedClass === cls.classId ? "border-secondary-400" : "border-slate-100"
                  }`}
                >
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-secondary-100 flex items-center justify-center text-2xl">🏫</div>
                    <div>
                      <h3 className="font-bold text-slate-800">{cls.className}</h3>
                      <p className="text-sm text-slate-500">{cls.subjectName}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Students in class */}
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-4 border-b border-slate-100">
            <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
              <span>🎓</span> Students
            </h2>
          </div>
          {!selectedClass ? (
            <div className="p-8 text-center text-slate-500">
              Select a class to view students
            </div>
          ) : enrollments.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              No students enrolled in this class yet
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {enrollments.map((e) => (
                <div key={e.id} className="p-4 flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-secondary-100 flex items-center justify-center text-secondary-600 font-bold text-sm">
                    {e.learnerFirstName?.[0]}{e.learnerLastName?.[0]}
                  </div>
                  <div>
                    <p className="font-medium text-slate-700">{e.learnerFirstName} {e.learnerLastName}</p>
                    <p className="text-xs text-slate-400">{e.learnerEmail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </DashboardShell>
  );
}
