"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";

interface NavItem {
  name: string;
  href: string;
  icon: string;
}

interface DashboardShellProps {
  children: React.ReactNode;
  navItems: NavItem[];
  roleLabel: string;
  roleColor: string;
}

export default function DashboardShell({ children, navItems, roleLabel, roleColor }: DashboardShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [user, setUser] = useState<{ firstName: string; lastName: string; email: string; role: string } | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    const stored = localStorage.getItem("el_user");
    if (stored) {
      setUser(JSON.parse(stored));
    } else {
      router.push("/login");
    }
  }, [router]);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    if (token) {
      fetch("/api/notifications", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => r.json())
        .then((data) => { if (data.success) setUnreadCount(data.data.unread); })
        .catch(console.error);
    }
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    localStorage.removeItem("el_token");
    localStorage.removeItem("el_user");
    router.push("/login");
  }

  if (!user) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="w-8 h-8 border-3 border-primary-200 border-t-primary-600 rounded-full animate-spin" />
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar Overlay */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 bg-white shadow-xl border-r border-slate-100 transform transition-transform duration-300 lg:translate-x-0 lg:static lg:z-auto ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="h-full flex flex-col">
          {/* Logo */}
          <div className="p-5 border-b border-slate-100">
            <Link href="/" className="flex items-center gap-3">
              <div className={`w-11 h-11 rounded-2xl ${roleColor} flex items-center justify-center text-white font-bold text-lg shadow-md`}>
                EL
              </div>
              <div>
                <p className="font-bold text-slate-800 text-sm">EasyLearn</p>
                <p className="text-xs text-slate-400">{roleLabel}</p>
              </div>
            </Link>
          </div>

          {/* Nav */}
          <nav className="flex-1 overflow-y-auto p-3 space-y-1">
            {navItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                    isActive
                      ? `${roleColor} text-white shadow-md`
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
                  }`}
                >
                  <span className="text-lg">{item.icon}</span>
                  {item.name}
                </Link>
              );
            })}
          </nav>

          {/* User Card */}
          <div className="p-4 border-t border-slate-100">
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-10 h-10 rounded-xl ${roleColor} flex items-center justify-center text-white font-bold text-sm`}>
                {user.firstName[0]}{user.lastName[0]}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm text-slate-700 truncate">{user.firstName} {user.lastName}</p>
                <p className="text-xs text-slate-400 truncate">{user.email}</p>
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="w-full py-2 rounded-xl text-sm font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors"
            >
              Log Out
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 bg-white/80 backdrop-blur-lg border-b border-slate-100 px-4 md:px-6">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(true)}
                className="lg:hidden p-2 rounded-xl hover:bg-slate-100"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <div>
                <p className="font-semibold text-slate-800 text-sm">Welcome back, {user.firstName}! 👋</p>
                <p className="text-xs text-slate-400">Have a productive day!</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Search */}
              <div className="hidden md:flex items-center gap-2 px-3 py-2 rounded-xl bg-slate-100 w-64">
                <span className="text-slate-400 text-sm">🔍</span>
                <input
                  type="text"
                  placeholder="Search..."
                  className="bg-transparent text-sm outline-none flex-1 text-slate-600"
                />
              </div>

              {/* Notifications */}
              <Link
                href={
                  user.role === "super_admin" || user.role === "school_admin" || user.role === "head_teacher"
                    ? "/dashboard/admin/announcements"
                    : user.role === "teacher"
                    ? "/dashboard/teacher/announcements"
                    : user.role === "parent"
                    ? "/dashboard/parent/announcements"
                    : "/dashboard/learner/announcements"
                }
                className="relative p-2 rounded-xl hover:bg-slate-100 transition-colors"
              >
                <span className="text-lg">🔔</span>
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 w-4 h-4 bg-red-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                    {unreadCount > 9 ? "9+" : unreadCount}
                  </span>
                )}
              </Link>

              {/* Profile */}
              <div className={`w-9 h-9 rounded-xl ${roleColor} flex items-center justify-center text-white font-bold text-xs`}>
                {user.firstName[0]}{user.lastName[0]}
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 p-4 md:p-6 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
