"use client";
import Link from "next/link";

export default function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md text-center bg-white p-8 rounded-2xl shadow-xl border border-slate-100">
        <div className="w-16 h-16 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-3xl mx-auto mb-6">
          🔒
        </div>
        <h1 className="text-2xl font-bold text-slate-800 mb-3">Registration Restricted</h1>
        <p className="text-slate-600 text-sm leading-relaxed mb-6">
          Public account registration is disabled. To get an account for EasyLearn, please contact your school administrator.
        </p>
        <Link href="/login" className="inline-block w-full py-3 rounded-xl bg-blue-600 text-white font-semibold shadow-md hover:bg-blue-700 transition-all">
          Return to Login
        </Link>
      </div>
    </div>
  );
}