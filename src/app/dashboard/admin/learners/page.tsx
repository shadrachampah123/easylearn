"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import UsersManager from "@/components/admin/UsersManager";
import { adminNav } from "@/lib/admin-nav";

export default function AdminLearnersPage() {
  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <UsersManager
        role="learner"
        title="Learners"
        subtitle="Manage learner accounts and enrollment"
        emptyEmoji="🎓"
      />
    </DashboardShell>
  );
}
