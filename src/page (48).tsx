"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import UsersManager from "@/components/admin/UsersManager";
import { adminNav } from "@/lib/admin-nav";

export default function AdminTeachersPage() {
  return (
    <DashboardShell navItems={adminNav} roleLabel="Administrator" roleColor="gradient-primary">
      <UsersManager
        role="teacher"
        title="Teachers"
        subtitle="Manage teacher accounts and assignments"
        emptyEmoji="👩‍🏫"
      />
    </DashboardShell>
  );
}
