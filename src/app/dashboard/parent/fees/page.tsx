"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";
import { useEffect, useState } from "react";

export default function ParentFeesPage() {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate loading to show empty state handling - no fee system yet in DB
    const timer = setTimeout(() => setLoading(false), 500);
    return () => clearTimeout(timer);
  }, []);

  if (loading) {
    return (
      <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-slate-200 rounded w-1/3" />
          <div className="grid md:grid-cols-2 gap-6">
            <div className="h-64 bg-slate-200 rounded-2xl" />
            <div className="h-64 bg-slate-200 rounded-2xl" />
          </div>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">School Fees</h1>
        <p className="text-sm text-slate-500">View and manage fee payments</p>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-8 text-center">
        <div className="text-6xl mb-4">💳</div>
        <h3 className="text-lg font-semibold text-slate-700 mb-2">Fee Management Coming Soon</h3>
        <p className="text-slate-500 text-sm max-w-md mx-auto mb-6">
          The school fee management system is not yet configured in the database. Once fee records are available, you will see a breakdown of tuition, transport, feeding, and materials with live payment status.
        </p>
        <div className="p-4 rounded-xl bg-blue-50 border border-blue-100 max-w-md mx-auto">
          <p className="text-sm text-blue-700">
            💡 <strong>Note:</strong> For now, please contact the school office directly to inquire about fee balances and make payments. This page will show live data once the fee module is implemented.
          </p>
        </div>
      </div>

      <div className="mt-6 bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
        <h2 className="font-bold text-lg text-slate-800 mb-4">What will be available</h2>
        <div className="grid md:grid-cols-2 gap-4 text-sm text-slate-600">
          <div className="flex items-start gap-2">
            <span className="text-green-500">✓</span>
            <span>Live tuition fee breakdown per term and academic year</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-green-500">✓</span>
            <span>Transport and feeding fees with due dates</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-green-500">✓</span>
            <span>Payment history and receipts</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-green-500">✓</span>
            <span>Online payment integration (future)</span>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
