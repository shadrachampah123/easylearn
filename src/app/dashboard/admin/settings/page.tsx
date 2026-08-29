/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

interface AcademicYear {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

interface Term {
  id: string;
  name: string;
  academicYearName: string;
  startDate: string;
  endDate: string;
  isCurrent: boolean;
}

interface CardOverride {
  id: string;
  cardKey: string;
  dashboardRole: string;
  title: string | null;
  label: string | null;
  value: string | null;
  subtitle: string | null;
  description: string | null;
  trend: string | null;
  isVisible: boolean;
  sortOrder: number;
  isEnabled: boolean;
  overridePayload: any;
  scopeType: string;
  scopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ActivityLog {
  id: string;
  actor: { id: string | null; name: string; role: string };
  action: string;
  entityType: string;
  entityId: string | null;
  description: string;
  timestamp: string;
}

export default function AdminSettingsPage() {
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [overrides, setOverrides] = useState<CardOverride[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"years" | "terms" | "overrides" | "activity">("years");
  const [showYearForm, setShowYearForm] = useState(false);
  const [showTermForm, setShowTermForm] = useState(false);
  const [showOverrideForm, setShowOverrideForm] = useState(false);
  const [editingOverride, setEditingOverride] = useState<CardOverride | null>(null);
  const [saving, setSaving] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataNotice, setDataNotice] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [yearForm, setYearForm] = useState({ name: "", startDate: "", endDate: "", isCurrent: false });
  const [termForm, setTermForm] = useState({ name: "term_1", academicYearId: "", startDate: "", endDate: "", isCurrent: false });
  const [overrideForm, setOverrideForm] = useState({
    cardKey: "",
    dashboardRole: "admin",
    title: "",
    label: "",
    value: "",
    subtitle: "",
    description: "",
    trend: "",
    isVisible: true,
    sortOrder: 0,
    isEnabled: true,
    scopeType: "global",
    scopeId: "",
  });
  const [activityLoading, setActivityLoading] = useState(false);

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [yearRes, termRes, overrideRes] = await Promise.all([
        fetch("/api/academic-years", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/terms", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/dashboard/overrides", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const yearData = await yearRes.json().catch(() => null);
      const termData = await termRes.json().catch(() => null);
      const overrideData = await overrideRes.json().catch(() => null);
      if (yearData?.success) setYears(yearData.data);
      if (termData?.success) setTerms(termData.data);
      if (overrideData?.success) {
        setOverrides(Array.isArray(overrideData.data) ? overrideData.data : []);
        setDataNotice(overrideData?.meta?.warning?.message || null);
        setDataError(null);
      } else {
        setOverrides([]);
        setDataNotice(null);
        setDataError(
          overrideData?.error ||
          `Card overrides could not be loaded (HTTP ${overrideRes.status}). If the database has not been migrated, run the pending files in drizzle/.`
        );
      }
    } catch (err) {
      console.error(err);
      setDataError("Academic years, terms or overrides could not be loaded. Please retry.");
    } finally {
      setLoading(false);
    }
  }

  async function loadActivity() {
    const token = localStorage.getItem("el_token");
    setActivityLoading(true);
    try {
      const res = await fetch("/api/activity-logs?limit=50", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setActivityLogs(Array.isArray(data.data?.logs) ? data.data.logs : []);
        setActivityError(data?.data?.meta?.warning?.message || null);
      } else {
        setActivityLogs([]);
        setActivityError(data?.error || `Activity log could not be loaded (HTTP ${res.status}).`);
      }
    } catch (err) {
      console.error(err);
      setActivityError("Activity log could not be loaded. Please retry.");
    } finally {
      setActivityLoading(false);
    }
  }

  useEffect(() => {
    if (activeTab === "activity") loadActivity();
  }, [activeTab]);

  async function handleCreateYear(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/academic-years", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(yearForm),
      });
      const data = await res.json();
      if (data.success) {
        setShowYearForm(false);
        setYearForm({ name: "", startDate: "", endDate: "", isCurrent: false });
        loadData();
      } else alert(data.error);
    } catch (err) { console.error(err); } finally { setSaving(false); }
  }

  async function handleCreateTerm(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch("/api/terms", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(termForm),
      });
      const data = await res.json();
      if (data.success) {
        setShowTermForm(false);
        setTermForm({ name: "term_1", academicYearId: "", startDate: "", endDate: "", isCurrent: false });
        loadData();
      } else alert(data.error);
    } catch (err) { console.error(err); } finally { setSaving(false); }
  }

  async function handleCreateOverride(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const url = editingOverride ? `/api/dashboard/overrides/${editingOverride.id}` : "/api/dashboard/overrides";
      const method = editingOverride ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...overrideForm,
          scopeId: overrideForm.scopeId || null,
          sortOrder: Number(overrideForm.sortOrder) || 0,
        }),
      });
      const data = await res.json();
      if (data.success) {
        setShowOverrideForm(false);
        setEditingOverride(null);
        setOverrideForm({
          cardKey: "",
          dashboardRole: "admin",
          title: "",
          label: "",
          value: "",
          subtitle: "",
          description: "",
          trend: "",
          isVisible: true,
          sortOrder: 0,
          isEnabled: true,
          scopeType: "global",
          scopeId: "",
        });
        loadData();
      } else alert(data.error);
    } catch (err) { console.error(err); } finally { setSaving(false); }
  }

  function openEditOverride(ov: CardOverride) {
    setEditingOverride(ov);
    setOverrideForm({
      cardKey: ov.cardKey,
      dashboardRole: ov.dashboardRole,
      title: ov.title || "",
      label: ov.label || "",
      value: ov.value || "",
      subtitle: ov.subtitle || "",
      description: ov.description || "",
      trend: ov.trend || "",
      isVisible: ov.isVisible,
      sortOrder: ov.sortOrder,
      isEnabled: ov.isEnabled,
      scopeType: ov.scopeType,
      scopeId: ov.scopeId || "",
    });
    setShowOverrideForm(true);
  }

  async function handleDeleteOverride(id: string) {
    if (!confirm("Delete this override? The card will revert to live data.")) return;
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/dashboard/overrides/${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) loadData();
      else alert(data.error);
    } catch (err) { console.error(err); }
  }

  async function toggleOverride(ov: CardOverride) {
    const token = localStorage.getItem("el_token");
    try {
      await fetch(`/api/dashboard/overrides/${ov.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ isEnabled: !ov.isEnabled }),
      });
      loadData();
    } catch (err) { console.error(err); }
  }

  const termLabels: Record<string, string> = { term_1: "First Term", term_2: "Second Term", term_3: "Third Term" };

  const tabs = [
    { id: "years", label: "Academic Years", icon: "📅" },
    { id: "terms", label: "Terms", icon: "🗓️" },
    { id: "overrides", label: "Card Overrides", icon: "🎛️" },
    { id: "activity", label: "Activity Log", icon: "📋" },
  ];

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">School Settings</h1>
        <p className="text-sm text-slate-500">Manage academic years, terms, dashboard overrides, and audit logs</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 overflow-x-auto pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap transition-all flex items-center gap-2 ${
              activeTab === tab.id ? "bg-primary-500 text-white shadow-lg" : "bg-white text-slate-600 border border-slate-200 hover:bg-slate-50"
            }`}
          >
            <span>{tab.icon}</span> {tab.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-slate-200 rounded-2xl" />
          <div className="h-32 bg-slate-200 rounded-2xl" />
        </div>
      ) : (
        <>
          {activeTab === "years" && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
                  <span>📅</span> Academic Years
                </h2>
                <button onClick={() => setShowYearForm(true)} className="px-4 py-2 rounded-xl gradient-primary text-white text-sm font-semibold">
                  + Add Year
                </button>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {years.map((year) => (
                  <div key={year.id} className={`p-5 rounded-2xl border-2 transition-all ${year.isCurrent ? "border-primary-400 bg-primary-50" : "border-slate-100 bg-white"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-bold text-slate-800">{year.name}</h3>
                      {year.isCurrent && <span className="px-2 py-0.5 rounded-full bg-primary-500 text-white text-xs font-semibold">Current</span>}
                    </div>
                    <p className="text-sm text-slate-500">{new Date(year.startDate).toLocaleDateString()} - {new Date(year.endDate).toLocaleDateString()}</p>
                  </div>
                ))}
                {years.length === 0 && <p className="text-slate-500 text-sm col-span-3 text-center py-8">No academic years yet</p>}
              </div>
            </div>
          )}

          {activeTab === "terms" && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
                  <span>🗓️</span> School Terms
                </h2>
                <button onClick={() => setShowTermForm(true)} className="px-4 py-2 rounded-xl gradient-primary text-white text-sm font-semibold">
                  + Add Term
                </button>
              </div>
              <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                {terms.map((term) => (
                  <div key={term.id} className={`p-5 rounded-2xl border-2 transition-all ${term.isCurrent ? "border-green-400 bg-green-50" : "border-slate-100 bg-white"}`}>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-bold text-slate-800">{termLabels[term.name] || term.name}</h3>
                      {term.isCurrent && <span className="px-2 py-0.5 rounded-full bg-green-500 text-white text-xs font-semibold">Current</span>}
                    </div>
                    <p className="text-xs text-slate-400 mb-1">{term.academicYearName}</p>
                    <p className="text-sm text-slate-500">{new Date(term.startDate).toLocaleDateString()} - {new Date(term.endDate).toLocaleDateString()}</p>
                  </div>
                ))}
                {terms.length === 0 && <p className="text-slate-500 text-sm col-span-3 text-center py-8">No terms yet</p>}
              </div>
            </div>
          )}

          {activeTab === "overrides" && (
            <div className="space-y-6">
              <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
                <h3 className="font-semibold text-amber-800 flex items-center gap-2">
                  <span>💡</span> About Card Overrides
                </h3>
                <p className="text-sm text-amber-700 mt-1">
                  Overrides let you manually set dashboard card values. By default cards show live computed data. When an active override exists, the override value is shown instead. You can disable or delete an override to revert to live data. The <span className="inline-flex w-4 h-4 rounded-full bg-amber-400 text-white text-[10px] items-center justify-center font-bold">!</span> badge on dashboard indicates overridden values.
                </p>
              </div>

              {dataError && (
                <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start justify-between gap-3">
                  <p className="text-sm text-red-700">❌ {dataError}</p>
                  <button onClick={() => loadData()} className="shrink-0 text-xs font-semibold text-red-700 hover:text-red-900">Retry</button>
                </div>
              )}

              {dataNotice && !dataError && (
                <div className="bg-sky-50 border border-sky-200 rounded-2xl p-4">
                  <p className="text-sm text-sky-800">ℹ️ {dataNotice}</p>
                </div>
              )}

              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                <div className="flex items-center justify-between mb-4">
                  <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
                    <span>🎛️</span> Dashboard Card Overrides ({overrides.length})
                  </h2>
                  <button onClick={() => { setEditingOverride(null); setShowOverrideForm(true); }} className="px-4 py-2 rounded-xl gradient-primary text-white text-sm font-semibold">
                    + New Override
                  </button>
                </div>

                {overrides.length === 0 ? (
                  <div className="text-center py-12">
                    <div className="text-4xl mb-3">🎛️</div>
                    <p className="text-slate-500 text-sm">No overrides configured</p>
                    <p className="text-slate-400 text-xs mt-1">All dashboards are showing live data</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {overrides.map((ov) => (
                      <div key={ov.id} className={`p-4 rounded-xl border-2 ${ov.isEnabled ? "border-slate-100 bg-white" : "border-slate-200 bg-slate-50 opacity-60"}`}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-sm text-slate-800">{ov.cardKey}</span>
                              <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-600 text-xs">{ov.dashboardRole}</span>
                              <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-600 text-xs">{ov.scopeType}{ov.scopeId ? `:${ov.scopeId.slice(0, 8)}` : ""}</span>
                              {ov.isEnabled ? <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-600 text-xs">Enabled</span> : <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs">Disabled</span>}
                              {!ov.isVisible && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs">Hidden</span>}
                            </div>
                            <div className="mt-2 text-sm">
                              <p className="text-slate-700">
                                <span className="text-slate-400">Title:</span> {ov.title || ov.label || "—"} | <span className="text-slate-400">Value:</span> <strong>{ov.value || "—"}</strong> {ov.trend && <span className="text-slate-500">({ov.trend})</span>}
                              </p>
                              {ov.subtitle && <p className="text-xs text-slate-500">Subtitle: {ov.subtitle}</p>}
                              {ov.description && <p className="text-xs text-slate-500">Desc: {ov.description}</p>}
                            </div>
                            <p className="text-xs text-slate-400 mt-1">Updated: {new Date(ov.updatedAt).toLocaleString()} • Sort: {ov.sortOrder}</p>
                          </div>
                          <div className="flex items-center gap-1">
                            <button onClick={() => toggleOverride(ov)} className={`px-3 py-1 rounded-lg text-xs font-semibold ${ov.isEnabled ? "bg-amber-100 text-amber-600 hover:bg-amber-200" : "bg-green-100 text-green-600 hover:bg-green-200"}`}>
                              {ov.isEnabled ? "Disable" : "Enable"}
                            </button>
                            <button onClick={() => openEditOverride(ov)} className="px-3 py-1 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100">Edit</button>
                            <button onClick={() => handleDeleteOverride(ov.id)} className="px-3 py-1 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100">Delete</button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
                <h3 className="font-bold text-slate-800 mb-3">Common Card Keys</h3>
                <div className="grid md:grid-cols-2 gap-2 text-xs">
                  <div className="p-2 rounded-lg bg-slate-50"><strong>admin_total_teachers</strong> - Total Teachers</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>admin_total_learners</strong> - Total Learners</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>admin_total_parents</strong> - Total Parents</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>admin_total_classes</strong> - Classes</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>admin_total_subjects</strong> - Subjects</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>teacher_my_classes</strong> - Teacher My Classes</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>learner_pending_assignments</strong> - Pending Assignments</div>
                  <div className="p-2 rounded-lg bg-slate-50"><strong>parent_average_grade</strong> - Average Grade</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "activity" && (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
                  <span>📋</span> Recent Activity Log
                </h2>
                <button onClick={loadActivity} disabled={activityLoading} className="px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold hover:bg-slate-200 disabled:opacity-50">
                  {activityLoading ? "Loading..." : "🔄 Refresh"}
                </button>
              </div>

              {activityError && (
                <div className="mb-4 p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start justify-between gap-3">
                  <p className="text-sm text-amber-800">⚠️ {activityError}</p>
                  <button onClick={loadActivity} className="shrink-0 text-xs font-semibold text-amber-700 hover:text-amber-900">Retry</button>
                </div>
              )}

              {activityLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="p-4 rounded-xl bg-slate-100 animate-pulse h-16" />
                  ))}
                </div>
              ) : activityLogs.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-4xl mb-3">📭</div>
                  <p className="text-slate-500 text-sm">No activity logs yet</p>
                  <p className="text-slate-400 text-xs mt-1">Logs will appear as you manage users, classes, assignments, etc.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {activityLogs.map((log) => (
                    <div key={log.id} className="p-4 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm text-slate-700">{log.description}</p>
                          <p className="text-xs text-slate-400 mt-1">
                            <span className="font-semibold">{log.actor.name}</span> {log.actor.role && `(${log.actor.role})`} • {log.action} {log.entityType} {log.entityId ? `• ${log.entityId.slice(0, 8)}` : ""}
                          </p>
                        </div>
                        <span className="text-xs text-slate-400 whitespace-nowrap">{new Date(log.timestamp).toLocaleString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Year Form Modal */}
      {showYearForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Add Academic Year</h2>
              <button onClick={() => setShowYearForm(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreateYear} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Name *</label>
                <input type="text" required value={yearForm.name} onChange={(e) => setYearForm({ ...yearForm, name: e.target.value })} placeholder="e.g., 2025/2026" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
                  <input type="date" required value={yearForm.startDate} onChange={(e) => setYearForm({ ...yearForm, startDate: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
                  <input type="date" required value={yearForm.endDate} onChange={(e) => setYearForm({ ...yearForm, endDate: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={yearForm.isCurrent} onChange={(e) => setYearForm({ ...yearForm, isCurrent: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                Set as current year
              </label>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowYearForm(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : "Add Year"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Term Form Modal */}
      {showTermForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-md animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">Add Term</h2>
              <button onClick={() => setShowTermForm(false)} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreateTerm} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Term *</label>
                <select value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="term_1">First Term</option>
                  <option value="term_2">Second Term</option>
                  <option value="term_3">Third Term</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Academic Year *</label>
                <select required value={termForm.academicYearId} onChange={(e) => setTermForm({ ...termForm, academicYearId: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="">Select year</option>
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>{y.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
                  <input type="date" required value={termForm.startDate} onChange={(e) => setTermForm({ ...termForm, startDate: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
                  <input type="date" required value={termForm.endDate} onChange={(e) => setTermForm({ ...termForm, endDate: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={termForm.isCurrent} onChange={(e) => setTermForm({ ...termForm, isCurrent: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                Set as current term
              </label>
              <div className="flex gap-3">
                <button type="button" onClick={() => setShowTermForm(false)} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : "Add Term"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Override Form Modal */}
      {showOverrideForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8 animate-scale-in">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">{editingOverride ? "Edit Override" : "New Card Override"}</h2>
              <button onClick={() => { setShowOverrideForm(false); setEditingOverride(null); }} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleCreateOverride} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Card Key *</label>
                  <input type="text" required value={overrideForm.cardKey} onChange={(e) => setOverrideForm({ ...overrideForm, cardKey: e.target.value })} placeholder="e.g., admin_total_teachers" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Dashboard Role *</label>
                  <select value={overrideForm.dashboardRole} onChange={(e) => setOverrideForm({ ...overrideForm, dashboardRole: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                    <option value="admin">Admin</option>
                    <option value="teacher">Teacher</option>
                    <option value="learner">Learner</option>
                    <option value="parent">Parent</option>
                    <option value="global">Global</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Title / Label</label>
                  <input type="text" value={overrideForm.title} onChange={(e) => setOverrideForm({ ...overrideForm, title: e.target.value })} placeholder="e.g., Total Teachers" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Value *</label>
                  <input type="text" required value={overrideForm.value} onChange={(e) => setOverrideForm({ ...overrideForm, value: e.target.value })} placeholder="e.g., 42 or 82%" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subtitle</label>
                  <input type="text" value={overrideForm.subtitle} onChange={(e) => setOverrideForm({ ...overrideForm, subtitle: e.target.value })} placeholder="e.g., Active this term" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Trend / Change</label>
                  <input type="text" value={overrideForm.trend} onChange={(e) => setOverrideForm({ ...overrideForm, trend: e.target.value })} placeholder="e.g., +5% or +2" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea value={overrideForm.description} onChange={(e) => setOverrideForm({ ...overrideForm, description: e.target.value })} rows={2} placeholder="Optional description" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none" />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Scope Type</label>
                  <select value={overrideForm.scopeType} onChange={(e) => setOverrideForm({ ...overrideForm, scopeType: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                    <option value="global">Global (all users)</option>
                    <option value="role">Role-wide</option>
                    <option value="class">Specific Class</option>
                    <option value="learner">Specific Learner</option>
                    <option value="parent">Specific Parent</option>
                    <option value="teacher">Specific Teacher</option>
                    <option value="user">Specific User</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Scope ID (optional)</label>
                  <input type="text" value={overrideForm.scopeId} onChange={(e) => setOverrideForm({ ...overrideForm, scopeId: e.target.value })} placeholder="UUID of scoped entity" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Sort Order</label>
                  <input type="number" value={overrideForm.sortOrder} onChange={(e) => setOverrideForm({ ...overrideForm, sortOrder: parseInt(e.target.value) || 0 })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                  <input type="checkbox" checked={overrideForm.isVisible} onChange={(e) => setOverrideForm({ ...overrideForm, isVisible: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                  Visible
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                  <input type="checkbox" checked={overrideForm.isEnabled} onChange={(e) => setOverrideForm({ ...overrideForm, isEnabled: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                  Enabled
                </label>
              </div>

              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowOverrideForm(false); setEditingOverride(null); }} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : editingOverride ? "Update Override" : "Create Override"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
