"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import UsersManager from "@/components/admin/UsersManager";
import ParentLearnerLinks from "@/components/admin/ParentLearnerLinks";
import { adminNav } from "@/lib/admin-nav";

export default function AdminParentsPage() {
  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <UsersManager
        role="parent"
        title="Parents"
        subtitle="Manage parent accounts and their linked children"
        emptyEmoji="👨‍👩‍👧"
      />
      <ParentLearnerLinks />
    </DashboardShell>
  );
}
