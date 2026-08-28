"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";

interface Resource {
  id: string;
  title: string;
  description: string | null;
  type: string;
  fileUrl: string | null;
  topic: string | null;
  week: number | null;
  isPinned: boolean;
  subjectName: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  createdAt: string;
}

const learnerNav = [
  { name: "Dashboard", href: "/dashboard/learner", icon: "🏠" },
  { name: "Assignments", href: "/dashboard/learner/assignments", icon: "📝" },
  { name: "Quizzes", href: "/dashboard/learner/quizzes", icon: "❓" },
  { name: "Study Materials", href: "/dashboard/learner/resources", icon: "📚" },
  { name: "Grades", href: "/dashboard/learner/grades", icon: "📊" },
  { name: "Achievements", href: "/dashboard/learner/achievements", icon: "🏆" },
];

const typeConfig: Record<string, { icon: string; color: string }> = {
  pdf: { icon: "📄", color: "bg-red-100 text-red-600" },
  docx: { icon: "📝", color: "bg-blue-100 text-blue-600" },
  pptx: { icon: "📊", color: "bg-orange-100 text-orange-600" },
  video: { icon: "🎥", color: "bg-purple-100 text-purple-600" },
  audio: { icon: "🎵", color: "bg-pink-100 text-pink-600" },
  image: { icon: "🖼️", color: "bg-green-100 text-green-600" },
  link: { icon: "🔗", color: "bg-cyan-100 text-cyan-600" },
  zip: { icon: "📦", color: "bg-yellow-100 text-yellow-600" },
};

export default function LearnerResourcesPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  useEffect(() => {
    loadResources();
  }, []);

  async function loadResources() {
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/resources", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) setResources(data.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  const filteredResources = resources.filter((r) => {
    if (filter !== "all" && r.type !== filter) return false;
    if (search && !r.title.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const pinnedResources = filteredResources.filter((r) => r.isPinned);
  const regularResources = filteredResources.filter((r) => !r.isPinned);

  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">Study Materials</h1>
        <p className="text-sm text-slate-500">Access notes, videos, and learning resources</p>
      </div>

      {/* Search & Filters */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 mb-6">
        <div className="flex flex-col md:flex-row gap-4">
          <div className="flex-1 relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search resources..."
              className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-accent-500 focus:border-transparent outline-none text-sm"
            />
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {[
              { key: "all", label: "All", icon: "📋" },
              { key: "pdf", label: "PDF", icon: "📄" },
              { key: "video", label: "Video", icon: "🎥" },
              { key: "pptx", label: "Slides", icon: "📊" },
              { key: "link", label: "Links", icon: "🔗" },
            ].map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={`px-3 py-2 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                  filter === f.key
                    ? "bg-accent-500 text-white"
                    : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                }`}
              >
                {f.icon} {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse">
              <div className="h-12 w-12 bg-slate-200 rounded-xl mb-4" />
              <div className="h-5 bg-slate-200 rounded w-2/3 mb-2" />
              <div className="h-4 bg-slate-100 rounded w-full" />
            </div>
          ))}
        </div>
      ) : filteredResources.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">📚</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No resources found</h3>
          <p className="text-slate-500 text-sm">
            {search ? "Try a different search term" : "Check back later for new materials"}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Pinned Resources */}
          {pinnedResources.length > 0 && (
            <div>
              <h2 className="font-bold text-slate-700 mb-3 flex items-center gap-2">
                <span>📌</span> Pinned Resources
              </h2>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {pinnedResources.map((resource) => (
                  <ResourceCard key={resource.id} resource={resource} />
                ))}
              </div>
            </div>
          )}

          {/* Regular Resources */}
          {regularResources.length > 0 && (
            <div>
              {pinnedResources.length > 0 && (
                <h2 className="font-bold text-slate-700 mb-3 flex items-center gap-2">
                  <span>📚</span> All Resources
                </h2>
              )}
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {regularResources.map((resource) => (
                  <ResourceCard key={resource.id} resource={resource} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardShell>
  );
}

function ResourceCard({ resource }: { resource: Resource }) {
  const config = typeConfig[resource.type] || typeConfig.link;

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-5 hover:shadow-md transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-12 h-12 rounded-xl ${config.color} flex items-center justify-center text-2xl group-hover:scale-110 transition-transform`}>
          {config.icon}
        </div>
        {resource.isPinned && <span>📌</span>}
      </div>

      <h3 className="font-bold text-slate-800 mb-1 line-clamp-1 group-hover:text-accent-600 transition-colors">
        {resource.title}
      </h3>

      <p className="text-slate-500 text-sm mb-3 line-clamp-2">
        {resource.description || "No description available"}
      </p>

      <div className="flex items-center gap-2 text-xs text-slate-400 mb-4">
        {resource.subjectName && (
          <span className="px-2 py-1 rounded-lg bg-slate-100">📚 {resource.subjectName}</span>
        )}
        {resource.topic && (
          <span className="px-2 py-1 rounded-lg bg-slate-100">{resource.topic}</span>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">
          By {resource.teacherFirstName} {resource.teacherLastName}
        </span>
        {resource.fileUrl ? (
          <a
            href={resource.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 rounded-xl bg-accent-100 text-accent-600 text-sm font-semibold hover:bg-accent-200 transition-colors"
          >
            Open →
          </a>
        ) : (
          <span className="px-4 py-2 rounded-xl bg-slate-100 text-slate-400 text-sm font-semibold cursor-default">
            No link
          </span>
        )}
      </div>
    </div>
  );
}
