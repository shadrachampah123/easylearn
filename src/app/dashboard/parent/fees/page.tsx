"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import { parentNav } from "@/lib/parent-nav";

export default function ParentFeesPage() {
  return (
    <DashboardShell navItems={parentNav} roleLabel="Parent" roleColor="bg-gradient-to-r from-lavender to-purple-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">School Fees</h1>
        <p className="text-sm text-slate-500">View and manage fee payments</p>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>💰</span> Fee Summary
          </h2>
          <div className="space-y-3">
            {[
              { label: "Tuition Fees", amount: "₵2,500.00", status: "Paid", color: "bg-green-100 text-green-600" },
              { label: "Transport", amount: "₵500.00", status: "Pending", color: "bg-orange-100 text-orange-600" },
              { label: "Feeding", amount: "₵600.00", status: "Paid", color: "bg-green-100 text-green-600" },
              { label: "Books & Materials", amount: "₵300.00", status: "Pending", color: "bg-orange-100 text-orange-600" },
            ].map((fee, i) => (
              <div key={i} className="flex items-center justify-between p-3 rounded-xl bg-slate-50">
                <span className="text-sm text-slate-600">{fee.label}</span>
                <div className="flex items-center gap-3">
                  <span className="font-semibold text-slate-800">{fee.amount}</span>
                  <span className={`px-2 py-1 rounded-full text-xs font-semibold ${fee.color}`}>{fee.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-6">
          <h2 className="font-bold text-lg text-slate-800 mb-4 flex items-center gap-2">
            <span>📊</span> Payment Overview
          </h2>
          <div className="text-center mb-6">
            <div className="text-5xl font-bold text-slate-800 mb-2">₵2,800</div>
            <p className="text-slate-500 text-sm">of ₵3,900 total fees</p>
          </div>
          <div className="w-full h-4 rounded-full bg-slate-100 overflow-hidden mb-6">
            <div className="h-full rounded-full bg-gradient-to-r from-green-400 to-green-600" style={{ width: "72%" }} />
          </div>
          <div className="p-4 rounded-xl bg-blue-50 border border-blue-100">
            <p className="text-sm text-blue-700">
              💳 <strong>Note:</strong> Online fee payment is coming soon. For now, please contact the school office to make payments.
            </p>
          </div>
        </div>
      </div>
    </DashboardShell>
  );
}
