"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import Link from "next/link";

interface Assignment {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: string | null;
  maxScore: number;
  className: string | null;
  subjectName: string | null;
  createdAt: string;
  submission: {
    id: string;
    status: string;
    score: number | null;
  } | null;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
];

export default function LearnerAssignmentsPage() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "pending" | "submitted" | "graded">("all");

  useEffect(() => {
    loadAssignments();
  }, []);

  async function loadAssignments() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/assignments?status=published", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setAssignments(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredAssignments = assignments.filter((a) => {
    if (filter === "all") return true;
    if (filter === "pending") return !a.submission || a.submission.status === "pending";
    if (filter === "submitted") return a.submission?.status === "submitted" || a.submission?.status === "late";
    if (filter === "graded") return a.submission?.status === "graded";
    return true;
  });

  const getStatusBadge = (assignment: Assignment) => {
    if (!assignment.submission || assignment.submission.status === "pending") {
      const isOverdue = assignment.dueDate && new Date(assignment.dueDate) < new Date();
      return isOverdue
        ? { text: "Overdue", color: "bg-red-100 text-red-600" }
        : { text: "Not Started", color: "bg-slate-100 text-slate-600" };
    }
    if (assignment.submission.status === "graded") {
      return { text: `${assignment.submission.score}/${assignment.maxScore}`, color: "bg-green-100 text-green-600" };
    }
    if (assignment.submission.status === "late") {
      return { text: "Submitted Late", color: "bg-orange-100 text-orange-600" };
    }
    return { text: "Submitted", color: "bg-blue-100 text-blue-600" };
  };

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Assignments</h1>
        <p className="text-sm text-slate-500">View and submit your assignments</p>
      </div>

      {/* Filters */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {[
          { key: "all", label: "All", icon: "📋" },
          { key: "pending", label: "Pending", icon: "⏳" },
          { key: "submitted", label: "Submitted", icon: "✅" },
          { key: "graded", label: "Graded", icon: "📊" },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key as typeof filter)}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${
              filter === f.key
                ? "bg-accent-500 text-white shadow-lg"
                : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            <span className="mr-1">{f.icon}</span> {f.label}
          </button>
        ))}
      </div>

      {/* Assignments List */}
      {loading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-5 bg-slate-200 rounded w-1/3 mb-3" />
              <div className="h-4 bg-slate-100 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : filteredAssignments.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📝</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No assignments found</h3>
          <p className="text-slate-500 text-sm">
            {filter === "all" ? "You don't have any assignments yet" : `No ${filter} assignments`}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredAssignments.map((assignment) => {
            const status = getStatusBadge(assignment);
            const isOverdue = assignment.dueDate && new Date(assignment.dueDate) < new Date();

            return (
              <Link
                key={assignment.id}
                href={`/dashboard/learner/assignments/${assignment.id}`}
                className="block p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md hover:border-accent-200 transition-all group"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="font-bold text-lg text-slate-800 group-hover:text-accent-600 transition-colors">
                        {assignment.title}
                      </h3>
                      <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${status.color}`}>
                        {status.text}
                      </span>
                    </div>
                    <p className="text-slate-500 text-sm mb-3 line-clamp-2">{assignment.description || "No description"}</p>
                    <div className="flex items-center gap-4 text-xs text-slate-400">
                      <span className="flex items-center gap-1">
                        <span>📚</span> {assignment.subjectName}
                      </span>
                      <span className="flex items-center gap-1">
                        <span>📊</span> {assignment.maxScore} points
                      </span>
                      {assignment.dueDate && (
                        <span className={`flex items-center gap-1 ${isOverdue ? "text-red-500" : ""}`}>
                          <span>📅</span> Due: {new Date(assignment.dueDate).toLocaleDateString()}
                          {isOverdue && " (Overdue)"}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!assignment.submission || assignment.submission.status === "pending" ? (
                      <span className="px-4 py-2 rounded-xl bg-accent-100 text-accent-600 font-semibold text-sm">
                        Start →
                      </span>
                    ) : (
                      <span className="text-slate-300 group-hover:text-accent-400 transition-colors text-xl">→</span>
                    )}
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
