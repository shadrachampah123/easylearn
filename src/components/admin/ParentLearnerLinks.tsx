/* eslint-disable react-hooks/set-state-in-effect */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RELATIONSHIP_OPTIONS,
  relationshipLabel,
} from "@/lib/relationships";

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  username: string | null;
  phone: string | null;
  isActive?: boolean;
}

interface ParentLink {
  id: string;
  parentId: string;
  learnerId: string;
  relationship: string | null;
  learnerFirstName?: string | null;
  learnerLastName?: string | null;
  learnerUsername?: string | null;
  learnerEmail?: string | null;
}

async function api(path: string, init?: RequestInit) {
  const token = typeof window === "undefined" ? "" : window.localStorage.getItem("el_token") || "";
  const headers: Record<string, string> = {};
  if (init?.body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  const json = await res.json().catch(() => null);

  if (!res.ok || !json?.success) {
    const message = json?.error || `Request failed (${res.status})`;
    const error = new Error(message) as Error & { meta?: unknown };
    error.meta = json?.meta;
    throw error;
  }
  return json as { data: unknown; meta?: { degraded?: boolean; warning?: { message?: string } } };
}

function fullName(person: { firstName: string; lastName: string }) {
  return `${person.firstName || ""} ${person.lastName || ""}`.trim() || "Unnamed";
}

/**
 * Admin-only tool for connecting parent accounts to learner accounts.
 * Everything is fetched through the same JWT cookie/token the rest of the admin pages use,
 * and every failure renders as a message in the panel rather than a broken page.
 */
export default function ParentLearnerLinks() {
  const [parents, setParents] = useState<Person[]>([]);
  const [links, setLinks] = useState<ParentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [onlyUnlinked, setOnlyUnlinked] = useState(false);
  const [filter, setFilter] = useState("");

  const [activeParent, setActiveParent] = useState<Person | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [learnerSearch, setLearnerSearch] = useState("");
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [newRelationship, setNewRelationship] = useState<string>("guardian");

  /** Never sets state synchronously: the mount effect below must not cascade renders. */
  const load = useCallback(async () => {
    try {
      const [parentRes, linkRes] = await Promise.all([
        api("/api/users?role=parent&limit=500"),
        api("/api/parent-learners"),
      ]);
      const parentData = parentRes.data as { users?: Person[] } | undefined;
      setParents(Array.isArray(parentData?.users) ? parentData.users : []);
      const linkData = linkRes.data;
      setLinks(Array.isArray(linkData) ? (linkData as ParentLink[]) : []);
      setNotice(
        (parentRes.meta?.warning?.message || linkRes.meta?.warning?.message) ?? null
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load parent links.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const linksByParent = useMemo(() => {
    const map = new Map<string, ParentLink[]>();
    for (const link of links) {
      const bucket = map.get(link.parentId);
      if (bucket) bucket.push(link);
      else map.set(link.parentId, [link]);
    }
    return map;
  }, [links]);

  const linkedLearnerIds = useMemo(() => {
    if (!activeParent) return new Set<string>();
    return new Set((linksByParent.get(activeParent.id) || []).map((link) => link.learnerId));
  }, [activeParent, linksByParent]);

  const visibleParents = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return parents.filter((parent) => {
      const count = linksByParent.get(parent.id)?.length ?? 0;
      if (onlyUnlinked && count > 0) return false;
      if (!term) return true;
      return [parent.firstName, parent.lastName, parent.email, parent.username, parent.phone]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [parents, filter, onlyUnlinked, linksByParent]);

  const unlinkedCount = useMemo(
    () => parents.filter((parent) => (linksByParent.get(parent.id)?.length ?? 0) === 0).length,
    [parents, linksByParent]
  );

  async function refreshLinks() {
    try {
      const res = await api("/api/parent-learners");
      setLinks(Array.isArray(res.data) ? (res.data as ParentLink[]) : []);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not refresh links.");
    }
  }

  async function searchCandidates(term: string) {
    if (!activeParent) return;
    setBusy(true);
    setActionError(null);
    try {
      const query = `/api/users?role=learner&limit=100${term ? `&search=${encodeURIComponent(term)}` : ""}`;
      const res = await api(query);
      const data = res.data as { users?: Person[] } | undefined;
      // Only hide learners this parent is already linked to - a learner can have a
      // mother and a father (or several guardians) linked to the same account.
      const alreadyLinkedToThisParent = new Set(
        links.filter((link) => link.parentId === activeParent.id).map((link) => link.learnerId)
      );
      setCandidates((data?.users || []).filter((learner) => !alreadyLinkedToThisParent.has(learner.id)));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not search learners.");
    } finally {
      setBusy(false);
    }
  }

  function openParent(parent: Person) {
    setActiveParent(parent);
    setActionError(null);
    setLearnerSearch("");
    setNewRelationship("guardian");
    void searchCandidates("");
  }

  async function linkLearner(learner: Person) {
    if (!activeParent) return;
    setBusy(true);
    setActionError(null);
    try {
      await api("/api/parent-learners", {
        method: "POST",
        body: JSON.stringify({
          parentId: activeParent.id,
          learnerId: learner.id,
          relationship: newRelationship,
        }),
      });
      await refreshLinks();
      setCandidates((current) => current.filter((candidate) => candidate.id !== learner.id));
      setNotice(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not link learner.";
      // A race with another admin is not a failure worth an error banner.
      if (!message.toLowerCase().includes("already linked")) setActionError(message);
      await refreshLinks();
    } finally {
      setBusy(false);
    }
  }

  async function unlinkLearner(linkId: string) {
    if (!activeParent) return;
    setBusy(true);
    setActionError(null);
    try {
      await api(`/api/parent-learners/${linkId}`, { method: "DELETE" });
      await refreshLinks();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not unlink learner.");
    } finally {
      setBusy(false);
    }
  }

  async function changeRelationship(linkId: string, relationship: string) {
    setActionError(null);
    setLinks((current) =>
      current.map((link) => (link.id === linkId ? { ...link, relationship } : link))
    );
    try {
      await api(`/api/parent-learners/${linkId}`, {
        method: "PUT",
        body: JSON.stringify({ relationship }),
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not update relationship.");
      await refreshLinks();
    }
  }

  const activeLinks = activeParent ? linksByParent.get(activeParent.id) || [] : [];

  return (
    <section className="mb-8 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
            <span>🔗</span> Parent &harr; Learner Links
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Link each parent account to their children so the parent dashboard shows real learners.
            {" "}{parents.length} {parents.length === 1 ? "parent" : "parents"} &middot; {links.length}{" "}
            {links.length === 1 ? "link" : "links"}
            {unlinkedCount > 0 ? (
              <span className="text-amber-600 font-medium"> &middot; {unlinkedCount} with no learner</span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setLoadError(null);
              setLoading(true);
              void load();
            }}
            className="px-3 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold hover:bg-slate-200 transition-colors"
          >
            Refresh
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={onlyUnlinked}
              onChange={(event) => setOnlyUnlinked(event.target.checked)}
              className="w-4 h-4 rounded border-slate-300"
            />
            Missing links only
          </label>
        </div>
      </div>

      {notice && (
        <div className="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 text-sm">
          ⚠️ {notice}
        </div>
      )}

      {loadError && (
        <div className="mb-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
          ❌ {loadError}
        </div>
      )}

      <div className="relative max-w-md mb-4">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span>
        <input
          type="text"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search parents by name, email, username or phone..."
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
        />
      </div>

      {loading ? (
        <div className="animate-pulse space-y-2">
          {[1, 2, 3].map((row) => (
            <div key={row} className="h-14 bg-slate-100 rounded-xl" />
          ))}
        </div>
      ) : visibleParents.length === 0 ? (
        <div className="text-center py-8">
          <div className="text-3xl mb-2">👨‍👩‍👧</div>
          <p className="text-sm text-slate-500">
            {parents.length === 0
              ? "No parent accounts yet. Add parents above, then link them to learners here."
              : "No parents match this filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-3 font-semibold">Parent</th>
                <th className="py-2 pr-3 font-semibold">Contact</th>
                <th className="py-2 pr-3 font-semibold">Linked learners</th>
                <th className="py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleParents.map((parent) => {
                const parentLinks = linksByParent.get(parent.id) || [];
                return (
                  <tr key={parent.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="py-3 pr-3">
                      <p className="font-semibold text-slate-800">{fullName(parent)}</p>
                      {parent.username ? (
                        <p className="text-xs text-slate-400">@{parent.username}</p>
                      ) : null}
                    </td>
                    <td className="py-3 pr-3 text-slate-500">
                      <p>{parent.email || "—"}</p>
                      {parent.phone ? <p className="text-xs text-slate-400">{parent.phone}</p> : null}
                    </td>
                    <td className="py-3 pr-3">
                      {parentLinks.length === 0 ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-amber-50 text-amber-700 text-xs font-semibold">
                          Not linked
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {parentLinks.map((link) => (
                            <span
                              key={link.id}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-green-50 text-green-700 text-xs font-medium"
                              title={`${relationshipLabel(link.relationship)} of ${link.learnerFirstName || ""} ${link.learnerLastName || ""}`.trim()}
                            >
                              {link.learnerFirstName} {link.learnerLastName}
                              <span className="text-green-500">· {relationshipLabel(link.relationship)}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-3 text-right whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => openParent(parent)}
                        className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 transition-colors"
                      >
                        {parentLinks.length === 0 ? "Link learners" : "Manage"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeParent && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setActiveParent(null)}
        >
          <div
            className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="p-6 border-b border-slate-100 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-bold text-slate-800">
                  Linked learners for {fullName(activeParent)}
                </h3>
                <p className="text-sm text-slate-500">
                  {activeParent.email || (activeParent.username ? `@${activeParent.username}` : "No contact on file")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveParent(null)}
                className="w-8 h-8 rounded-lg bg-slate-100 flex items-center justify-center text-slate-500 hover:bg-slate-200 text-lg"
              >
                &times;
              </button>
            </div>

            <div className="p-6 space-y-6">
              {actionError && (
                <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm">
                  ❌ {actionError}
                </div>
              )}

              <div>
                <p className="text-sm font-semibold text-slate-700 mb-2">
                  Current links ({activeLinks.length})
                </p>
                {activeLinks.length === 0 ? (
                  <p className="text-sm text-slate-500 bg-slate-50 rounded-xl p-3">
                    No learners linked yet. Search below to add the first one.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {activeLinks.map((link) => (
                      <li
                        key={link.id}
                        className="flex flex-wrap items-center gap-2 p-3 rounded-xl border border-slate-100 bg-slate-50/60"
                      >
                        <div className="flex-1 min-w-[10rem]">
                          <p className="font-medium text-slate-800 text-sm">
                            {link.learnerFirstName} {link.learnerLastName}
                          </p>
                          <p className="text-xs text-slate-400">
                            {link.learnerUsername
                              ? `@${link.learnerUsername}`
                              : link.learnerEmail || "No username"}
                          </p>
                        </div>
                        <select
                          value={
                            (RELATIONSHIP_OPTIONS as readonly string[]).includes(link.relationship || "")
                              ? link.relationship || "guardian"
                              : "other"
                          }
                          disabled={busy}
                          onChange={(event) => void changeRelationship(link.id, event.target.value)}
                          className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm outline-none focus:ring-2 focus:ring-blue-500"
                        >
                          {RELATIONSHIP_OPTIONS.map((option) => (
                            <option key={option} value={option}>
                              {relationshipLabel(option)}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void unlinkLearner(link.id)}
                          className="px-3 py-2 rounded-xl bg-red-50 text-red-600 text-xs font-semibold hover:bg-red-100 transition-colors disabled:opacity-50"
                        >
                          Unlink
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="pt-2 border-t border-slate-100">
                <p className="text-sm font-semibold text-slate-700 mb-2">Add a learner</p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void searchCandidates(learnerSearch.trim());
                  }}
                  className="flex flex-col sm:flex-row gap-2 mb-3"
                >
                  <input
                    type="text"
                    value={learnerSearch}
                    onChange={(event) => setLearnerSearch(event.target.value)}
                    placeholder="Search learners by name, email or username"
                    className="flex-1 px-4 py-2.5 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm"
                  />
                  <select
                    value={newRelationship}
                    onChange={(event) => setNewRelationship(event.target.value)}
                    className="px-3 py-2.5 rounded-xl border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {RELATIONSHIP_OPTIONS.map((option) => (
                      <option key={option} value={option}>
                        {relationshipLabel(option)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="submit"
                    disabled={busy}
                    className="px-4 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    Search
                  </button>
                </form>

                {candidates.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    No unlinked learners matched that search. Every learner can only be added once per parent.
                  </p>
                ) : (
                  <ul className="space-y-2 max-h-64 overflow-y-auto">
                    {candidates.map((learner) => {
                      const alreadyLinked = linkedLearnerIds.has(learner.id);
                      return (
                        <li
                          key={learner.id}
                          className="flex items-center gap-3 p-3 rounded-xl border border-slate-100"
                        >
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-slate-800 text-sm truncate">
                              {fullName(learner)}
                            </p>
                            <p className="text-xs text-slate-400 truncate">
                              {learner.email || (learner.username ? `@${learner.username}` : "No contact")}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={busy || alreadyLinked}
                            onClick={() => void linkLearner(learner)}
                            className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs font-semibold hover:bg-green-700 transition-colors disabled:opacity-50"
                          >
                            {alreadyLinked ? "Linked" : "Link"}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>

            <div className="p-6 border-t border-slate-100 flex gap-3">
              <button
                type="button"
                onClick={() => setActiveParent(null)}
                className="flex-1 py-3 rounded-xl bg-slate-100 text-slate-600 font-semibold hover:bg-slate-200 transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
