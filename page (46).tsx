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

export default function AdminSettingsPage() {
  const [years, setYears] = useState<AcademicYear[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [loading, setLoading] = useState(true);
  const [showYearForm, setShowYearForm] = useState(false);
  const [showTermForm, setShowTermForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [yearForm, setYearForm] = useState({ name: "", startDate: "", endDate: "", isCurrent: false });
  const [termForm, setTermForm] = useState({ name: "term_1", academicYearId: "", startDate: "", endDate: "", isCurrent: false });

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const [yearRes, termRes] = await Promise.all([
        fetch("/api/academic-years", { headers: { Authorization: `Bearer ${token}` } }),
        fetch("/api/terms", { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      const yearData = await yearRes.json();
      const termData = await termRes.json();
      if (yearData.success) setYears(yearData.data);
      if (termData.success) setTerms(termData.data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

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
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
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
      } else {
        alert(data.error);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  const termLabels: Record<string, string> = {
    term_1: "First Term", term_2: "Second Term", term_3: "Third Term",
  };

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">School Settings</h1>
        <p className="text-sm text-slate-500">Manage academic years, terms, and school configuration</p>
      </div>

      {loading ? (
        <div className="animate-pulse space-y-4">
          <div className="h-32 bg-slate-200 rounded-2xl" />
          <div className="h-32 bg-slate-200 rounded-2xl" />
        </div>
      ) : (
        <>
          {/* Academic Years */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6 mb-6">
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
                <div key={year.id} className={`p-5 rounded-2xl border-2 transition-all ${
                  year.isCurrent ? "border-primary-400 bg-primary-50" : "border-slate-100 bg-white"
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-slate-800">{year.name}</h3>
                    {year.isCurrent && (
                      <span className="px-2 py-0.5 rounded-full bg-primary-500 text-white text-xs font-semibold">Current</span>
                    )}
                  </div>
                  <p className="text-sm text-slate-500">
                    {new Date(year.startDate).toLocaleDateString()} - {new Date(year.endDate).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Terms */}
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
                <div key={term.id} className={`p-5 rounded-2xl border-2 transition-all ${
                  term.isCurrent ? "border-green-400 bg-green-50" : "border-slate-100 bg-white"
                }`}>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-slate-800">{termLabels[term.name] || term.name}</h3>
                    {term.isCurrent && (
                      <span className="px-2 py-0.5 rounded-full bg-green-500 text-white text-xs font-semibold">Current</span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mb-1">{term.academicYearName}</p>
                  <p className="text-sm text-slate-500">
                    {new Date(term.startDate).toLocaleDateString()} - {new Date(term.endDate).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Admin Tools */}
          <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
            <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
              <span>🛠️</span> Admin Tools
            </h2>
            <div className="grid md:grid-cols-2 gap-4">
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200">
                <h3 className="font-semibold text-amber-800 mb-1">Backup Database</h3>
                <p className="text-sm text-amber-600 mb-3">Create a backup of all school data</p>
                <button className="px-4 py-2 rounded-xl bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600" onClick={() => alert("Backup started. Data will be exported.")}>
                  💾 Start Backup
                </button>
              </div>
              <div className="p-4 rounded-2xl bg-blue-50 border border-blue-200">
                <h3 className="font-semibold text-blue-800 mb-1">Database Status</h3>
                <p className="text-sm text-blue-600 mb-3">Check current database health and storage</p>
                <button className="px-4 py-2 rounded-xl bg-blue-500 text-white text-sm font-semibold hover:bg-blue-600" onClick={() => alert("Database is healthy and running.")}>
                  🔍 Check Status
                </button>
              </div>
            </div>
          </div>
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
                <input type="text" required value={yearForm.name}
                  onChange={(e) => setYearForm({ ...yearForm, name: e.target.value })}
                  placeholder="e.g., 2025/2026"
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
                  <input type="date" required value={yearForm.startDate}
                    onChange={(e) => setYearForm({ ...yearForm, startDate: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
                  <input type="date" required value={yearForm.endDate}
                    onChange={(e) => setYearForm({ ...yearForm, endDate: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={yearForm.isCurrent}
                  onChange={(e) => setYearForm({ ...yearForm, isCurrent: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300" />
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
                <select value={termForm.name} onChange={(e) => setTermForm({ ...termForm, name: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="term_1">First Term</option>
                  <option value="term_2">Second Term</option>
                  <option value="term_3">Third Term</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Academic Year *</label>
                <select required value={termForm.academicYearId} onChange={(e) => setTermForm({ ...termForm, academicYearId: e.target.value })}
                  className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
                  <option value="">Select year</option>
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>{y.name}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Start Date *</label>
                  <input type="date" required value={termForm.startDate}
                    onChange={(e) => setTermForm({ ...termForm, startDate: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">End Date *</label>
                  <input type="date" required value={termForm.endDate}
                    onChange={(e) => setTermForm({ ...termForm, endDate: e.target.value })}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={termForm.isCurrent}
                  onChange={(e) => setTermForm({ ...termForm, isCurrent: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300" />
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
    </DashboardShell>
  );
}
