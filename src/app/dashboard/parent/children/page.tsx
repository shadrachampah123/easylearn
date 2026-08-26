"use client";

import { useEffect, useState } from "react";
import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

interface Child {
  id: string;
  parentId: string;
  learnerId: string;
  relationship: string | null;
  parentFirstName: string;
  parentLastName: string;
}

interface Learner {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export default function ParentChildrenPage() {
  const [children, setChildren] = useState<Child[]>([]);
  const [learnerInfo, setLearnerInfo] = useState<Record<string, Learner>>({});
  const [currentParentId, setCurrentParentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setCurrentParentId(data.data.user.id);
          loadChildren(data.data.user.id);
        }
      });
  }, []);

  async function loadChildren(parentId: string) {
    const token = localStorage.getItem("el_token");
    setLoading(true);
    try {
      const res = await fetch(`/api/parent-learners?parentId=${parentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setChildren(data.data);
        // Load learner info for each
        const learners: Record<string, Learner> = {};
        const learnerRes = await fetch("/api/users?role=learner&limit=100", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const learnerData = await learnerRes.json();
        if (learnerData.success) {
          learnerData.data.users.forEach((l: Learner) => { learners[l.id] = l; });
        }
        setLearnerInfo(learners);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Children</h1>
        <p className="text-sm text-slate-500">Children linked to your account</p>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {[1, 2].map((i) => (
            <div key={i} className="p-6 rounded-2xl bg-white animate-pulse"><div className="h-5 bg-slate-200 rounded w-1/2" /></div>
          ))}
        </div>
      ) : children.length === 0 ? (
        <div className="text-center py-16 bg-white rounded-2xl shadow-sm border border-slate-100">
          <div className="text-6xl mb-4">👧</div>
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No children linked yet</h3>
          <p className="text-slate-500 text-sm">Contact the school administrator to link your children to this account</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {children.map((child) => {
            const learner = learnerInfo[child.learnerId];
            return (
              <div key={child.id} className="p-6 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all">
                <div className="flex items-center gap-4">
                  <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center text-white text-2xl font-bold shadow-md">
                    {learner?.firstName?.[0]}{learner?.lastName?.[0]}
                  </div>
                  <div className="flex-1">
                    <h3 className="font-bold text-lg text-slate-800">
                      {learner?.firstName} {learner?.lastName}
                    </h3>
                    <p className="text-sm text-slate-500">{learner?.email}</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <span className="px-3 py-1 rounded-full bg-purple-100 text-purple-600 text-xs font-semibold">
                    {child.relationship || "Parent"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </DashboardShell>
  );
}
