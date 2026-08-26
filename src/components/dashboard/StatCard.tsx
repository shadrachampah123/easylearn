"use client";

interface StatCardProps {
  icon: string;
  label: string;
  value: string | number;
  change?: string;
  color: string;
}

export default function StatCard({ icon, label, value, change, color }: StatCardProps) {
  return (
    <div className="p-5 rounded-2xl bg-white shadow-sm border border-slate-100 hover:shadow-md transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className={`w-12 h-12 rounded-xl ${color} flex items-center justify-center text-xl group-hover:scale-110 transition-transform`}>
          {icon}
        </div>
        {change && (
          <span className={`text-xs font-semibold px-2 py-1 rounded-lg ${change.startsWith("+") ? "bg-green-100 text-green-600" : "bg-red-100 text-red-600"}`}>
            {change}
          </span>
        )}
      </div>
      <p className="text-2xl font-bold text-slate-800">{value}</p>
      <p className="text-xs text-slate-500 mt-1">{label}</p>
    </div>
  );
}
