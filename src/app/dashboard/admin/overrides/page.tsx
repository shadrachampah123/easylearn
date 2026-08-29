/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { adminNav } from "@/lib/admin-nav";

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
  scopeType: string;
  scopeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export default function AdminOverridesPage() {
  const [overrides, setOverrides] = useState<CardOverride[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CardOverride | null>(null);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState({
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

  useEffect(() => { load(); }, []);

  async function load() {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/overrides", { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) setOverrides(data.data);
    } catch (err) { console.error(err); } finally { setLoading(false); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    const token = localStorage.getItem("el_token");
    try {
      const url = editing ? `/api/dashboard/overrides/${editing.id}` : "/api/dashboard/overrides";
      const method = editing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...form, scopeId: form.scopeId || null, sortOrder: Number(form.sortOrder) || 0 }),
      });
      const data = await res.json();
      if (data.success) {
        setShowForm(false);
        setEditing(null);
        setForm({ cardKey: "", dashboardRole: "admin", title: "", label: "", value: "", subtitle: "", description: "", trend: "", isVisible: true, sortOrder: 0, isEnabled: true, scopeType: "global", scopeId: "" });
        load();
      } else alert(data.error);
    } catch (err) { console.error(err); } finally { setSaving(false); }
  }

  function openEdit(ov: CardOverride) {
    setEditing(ov);
    setForm({
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
    setShowForm(true);
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this override? Card will revert to live data.")) return;
    const token = localStorage.getItem("el_token");
    try {
      const res = await fetch(`/api/dashboard/overrides/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (data.success) load();
      else alert(data.error);
    } catch (err) { console.error(err); }
  }

  async function toggle(ov: CardOverride) {
    const token = localStorage.getItem("el_token");
    try {
      await fetch(`/api/dashboard/overrides/${ov.id}`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ isEnabled: !ov.isEnabled }) });
      load();
    } catch (err) { console.error(err); }
  }

  const filtered = overrides.filter((ov) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return ov.cardKey.toLowerCase().includes(s) || (ov.title || "").toLowerCase().includes(s) || (ov.label || "").toLowerCase().includes(s);
  });

  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <div className="flex items-center justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Dashboard Card Overrides</h1>
          <p className="text-sm text-slate-500">Manually override card values - live data is shown by default</p>
        </div>
        <button onClick={() => { setEditing(null); setShowForm(true); }} className="px-5 py-2.5 rounded-xl gradient-primary text-white font-semibold shadow-lg hover:shadow-xl transition-all">
          + New Override
        </button>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 mb-6">
        <h3 className="font-semibold text-amber-800 flex items-center gap-2">💡 How overrides work</h3>
        <p className="text-sm text-amber-700 mt-1">
          Each card on dashboards shows <strong>live computed data</strong> by default. When you create an <strong>active override</strong>, the dashboard will show your manual value instead. The <span className="inline-flex w-4 h-4 rounded-full bg-amber-400 text-white text-[10px] items-center justify-center font-bold">!</span> badge indicates an overridden card. Disable or delete the override to revert to live data. Overrides can be global or scoped to a specific role, class, learner, parent, or teacher.
        </p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 mb-6">
        <div className="flex items-center gap-3">
          <span className="text-slate-400">🔍</span>
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by card key, title..." className="flex-1 px-3 py-2 rounded-xl border border-slate-200 outline-none text-sm" />
          <span className="text-xs text-slate-400">{filtered.length} of {overrides.length}</span>
        </div>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/3" /></div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">🎛️</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">{search ? "No matching overrides" : "No overrides configured"}</h3>
          <p className="text-slate-500 text-sm">{search ? "Try a different search" : "All dashboards are showing live data"}</p>
          {!search && (
            <button onClick={() => setShowForm(true)} className="mt-4 px-6 py-3 rounded-xl gradient-primary text-white font-semibold">Create First Override</button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((ov) => (
            <div key={ov.id} className={`p-5 rounded-2xl border-2 ${ov.isEnabled ? "border-slate-100 bg-white" : "border-slate-200 bg-slate-50 opacity-60"}`}>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-[250px]">
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <span className="font-bold text-slate-800">{ov.cardKey}</span>
                    <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-600 text-xs">{ov.dashboardRole}</span>
                    <span className="px-2 py-0.5 rounded-full bg-purple-100 text-purple-600 text-xs">{ov.scopeType}{ov.scopeId ? `:${ov.scopeId.slice(0, 8)}` : ""}</span>
                    {ov.isEnabled ? <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-600 text-xs">Enabled</span> : <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs">Disabled</span>}
                    {!ov.isVisible && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 text-xs">Hidden</span>}
                  </div>
                  <p className="text-sm text-slate-700"><span className="text-slate-400">Title:</span> {ov.title || ov.label || "—"} | <span className="text-slate-400">Value:</span> <strong className="text-primary-600">{ov.value || "—"}</strong> {ov.trend && <span className="text-slate-500">({ov.trend})</span>}</p>
                  {ov.subtitle && <p className="text-xs text-slate-500 mt-1">Subtitle: {ov.subtitle}</p>}
                  {ov.description && <p className="text-xs text-slate-500">Description: {ov.description}</p>}
                  <p className="text-xs text-slate-400 mt-2">Sort: {ov.sortOrder} • Updated: {new Date(ov.updatedAt).toLocaleString()}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => toggle(ov)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${ov.isEnabled ? "bg-amber-100 text-amber-700 hover:bg-amber-200" : "bg-green-100 text-green-700 hover:bg-green-200"}`}>{ov.isEnabled ? "Disable" : "Enable"}</button>
                  <button onClick={() => openEdit(ov)} className="px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 text-xs font-semibold hover:bg-blue-100">Edit</button>
                  <button onClick={() => handleDelete(ov.id)} className="px-3 py-1.5 rounded-lg bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100">Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 overflow-y-auto">
          <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl my-8">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h2 className="text-xl font-bold text-slate-800">{editing ? "Edit Override" : "New Card Override"}</h2>
              <button onClick={() => { setShowForm(false); setEditing(null); }} className="text-slate-400 hover:text-slate-600 text-2xl">&times;</button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Card Key *</label>
                  <input type="text" required value={form.cardKey} onChange={(e) => setForm({ ...form, cardKey: e.target.value })} placeholder="e.g., admin_total_teachers" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Dashboard Role *</label>
                  <select value={form.dashboardRole} onChange={(e) => setForm({ ...form, dashboardRole: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
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
                  <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g., Total Teachers" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Value *</label>
                  <input type="text" required value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} placeholder="e.g., 42 or 82%" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Subtitle</label>
                  <input type="text" value={form.subtitle} onChange={(e) => setForm({ ...form, subtitle: e.target.value })} placeholder="e.g., Active this term" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Trend / Change</label>
                  <input type="text" value={form.trend} onChange={(e) => setForm({ ...form, trend: e.target.value })} placeholder="e.g., +5% or +2" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Description</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Optional description" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Scope Type</label>
                  <select value={form.scopeType} onChange={(e) => setForm({ ...form, scopeType: e.target.value })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm">
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
                  <input type="text" value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })} placeholder="UUID of scoped entity" className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Sort Order</label>
                  <input type="number" value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: parseInt(e.target.value) || 0 })} className="w-full px-4 py-3 rounded-xl border border-slate-200 outline-none text-sm" />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                  <input type="checkbox" checked={form.isVisible} onChange={(e) => setForm({ ...form, isVisible: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                  Visible
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
                  <input type="checkbox" checked={form.isEnabled} onChange={(e) => setForm({ ...form, isEnabled: e.target.checked })} className="w-4 h-4 rounded border-slate-300" />
                  Enabled
                </label>
              </div>
              <div className="flex gap-3 pt-2">
                <button type="button" onClick={() => { setShowForm(false); setEditing(null); }} className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold">Cancel</button>
                <button type="submit" disabled={saving} className="flex-1 py-3 rounded-xl gradient-primary text-white font-semibold disabled:opacity-50">
                  {saving ? "Saving..." : editing ? "Update Override" : "Create Override"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </DashboardShell>
  );
}
