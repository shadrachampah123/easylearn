"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import LearnerProgressPanel from "@/components/dashboard/LearnerProgressPanel";
import { teacherNav } from "@/lib/teacher-nav";

export default function TeacherGradesPage() {
  return (
    <DashboardShell navItems={teacherNav} roleLabel="Teacher" roleColor="gradient-secondary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Grades</h1>
        <p className="text-sm text-slate-500">Select a learner to review individual grades, submissions, and quiz performance.</p>
      </div>
      <LearnerProgressPanel />
    </DashboardShell>
  );
}
