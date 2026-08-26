"use client";

import DashboardShell from "@/components/dashboard/DashboardShell";
import { learnerNav } from "@/lib/learner-nav";

const schedule = [
  { day: "Monday", classes: [
    { time: "7:30-8:30", subject: "Mathematics", teacher: "Mrs. Mensah", room: "Rm 12", color: "bg-blue-50 border-blue-200 text-blue-700" },
    { time: "8:45-9:45", subject: "English", teacher: "Mr. Osei", room: "Rm 12", color: "bg-green-50 border-green-200 text-green-700" },
    { time: "10:00-11:00", subject: "Science", teacher: "Mrs. Mensah", room: "Lab 1", color: "bg-purple-50 border-purple-200 text-purple-700" },
    { time: "11:15-12:15", subject: "Social Studies", teacher: "Mr. Boateng", room: "Rm 12", color: "bg-orange-50 border-orange-200 text-orange-700" },
  ]},
  { day: "Tuesday", classes: [
    { time: "7:30-8:30", subject: "English", teacher: "Mr. Osei", room: "Rm 12", color: "bg-green-50 border-green-200 text-green-700" },
    { time: "8:45-9:45", subject: "Mathematics", teacher: "Mrs. Mensah", room: "Rm 12", color: "bg-blue-50 border-blue-200 text-blue-700" },
    { time: "10:00-11:00", subject: "French", teacher: "Ms. Amoah", room: "Rm 14", color: "bg-pink-50 border-pink-200 text-pink-700" },
    { time: "11:15-12:15", subject: "ICT", teacher: "Mr. Addo", room: "Comp Lab", color: "bg-cyan-50 border-cyan-200 text-cyan-700" },
  ]},
  { day: "Wednesday", classes: [
    { time: "7:30-8:30", subject: "Science", teacher: "Mrs. Mensah", room: "Lab 1", color: "bg-purple-50 border-purple-200 text-purple-700" },
    { time: "8:45-9:45", subject: "Mathematics", teacher: "Mrs. Mensah", room: "Rm 12", color: "bg-blue-50 border-blue-200 text-blue-700" },
    { time: "10:00-11:00", subject: "Creative Arts", teacher: "Mrs. Owusu", room: "Art Room", color: "bg-red-50 border-red-200 text-red-700" },
    { time: "11:15-12:15", subject: "Physical Ed", teacher: "Coach Yaw", room: "Field", color: "bg-yellow-50 border-yellow-200 text-yellow-700" },
  ]},
  { day: "Thursday", classes: [
    { time: "7:30-8:30", subject: "English", teacher: "Mr. Osei", room: "Rm 12", color: "bg-green-50 border-green-200 text-green-700" },
    { time: "8:45-9:45", subject: "Social Studies", teacher: "Mr. Boateng", room: "Rm 12", color: "bg-orange-50 border-orange-200 text-orange-700" },
    { time: "10:00-11:00", subject: "Science", teacher: "Mrs. Mensah", room: "Lab 1", color: "bg-purple-50 border-purple-200 text-purple-700" },
    { time: "11:15-12:15", subject: "RME", teacher: "Mr. Kwaku", room: "Rm 12", color: "bg-indigo-50 border-indigo-200 text-indigo-700" },
  ]},
  { day: "Friday", classes: [
    { time: "7:30-8:30", subject: "Mathematics", teacher: "Mrs. Mensah", room: "Rm 12", color: "bg-blue-50 border-blue-200 text-blue-700" },
    { time: "8:45-9:45", subject: "Ghanaian Language", teacher: "Mrs. Appiah", room: "Rm 12", color: "bg-teal-50 border-teal-200 text-teal-700" },
    { time: "10:00-11:00", subject: "ICT", teacher: "Mr. Addo", room: "Comp Lab", color: "bg-cyan-50 border-cyan-200 text-cyan-700" },
    { time: "11:15-12:15", subject: "Club Activities", teacher: "Various", room: "Various", color: "bg-slate-50 border-slate-200 text-slate-700" },
  ]},
];

export default function LearnerTimetablePage() {
  return (
    <DashboardShell navItems={learnerNav} roleLabel="Learner" roleColor="bg-gradient-to-r from-accent-500 to-accent-600">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-800">My Timetable</h1>
        <p className="text-sm text-slate-500">Weekly class schedule</p>
      </div>

      <div className="grid lg:grid-cols-5 gap-4">
        {schedule.map((day) => (
          <div key={day.day} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-3 bg-gradient-to-r from-primary-500 to-primary-600 text-white text-center">
              <p className="font-bold text-sm">{day.day}</p>
            </div>
            <div className="p-3 space-y-3">
              {day.classes.map((cls, i) => (
                <div key={i} className={`p-3 rounded-xl border-2 ${cls.color}`}>
                  <p className="text-[10px] font-mono text-slate-400">{cls.time}</p>
                  <p className="font-semibold text-sm mt-1">{cls.subject}</p>
                  <p className="text-[10px] text-slate-500 mt-1">{cls.teacher} • {cls.room}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </DashboardShell>
  );
}
