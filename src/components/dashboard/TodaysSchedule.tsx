"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  TIMETABLE_DAYS,
  formatTimeSlot,
  subjectColor,
  teacherName,
  type DayValue,
  type TimetableEntry,
} from "@/components/dashboard/TimetableGrid";

type ScheduleStatus = "completed" | "current" | "upcoming";

interface TodaysScheduleProps {
  title?: string;
  emptyMessage?: string;
  showClass?: boolean;
  showTeacher?: boolean;
  viewAllHref?: string;
  className?: string;
}

function currentDay(): { value: DayValue; label: string } {
  // TIMETABLE_DAYS starts on Monday whereas Date#getDay starts on Sunday.
  return TIMETABLE_DAYS[(new Date().getDay() + 6) % TIMETABLE_DAYS.length];
}

function timeInMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

function scheduleStatus(entry: TimetableEntry): ScheduleStatus {
  const now = new Date();
  const currentTime = now.getHours() * 60 + now.getMinutes();

  if (currentTime >= timeInMinutes(entry.endTime)) return "completed";
  if (currentTime >= timeInMinutes(entry.startTime)) return "current";
  return "upcoming";
}

const statusStyles: Record<
  ScheduleStatus,
  { label: string; className: string }
> = {
  completed: {
    label: "Done",
    className: "bg-slate-100 text-slate-500",
  },
  current: {
    label: "Now",
    className: "bg-green-100 text-green-700",
  },
  upcoming: {
    label: "Upcoming",
    className: "bg-blue-100 text-blue-700",
  },
};

/**
 * A role-aware view of the signed-in user's periods for their local current day.
 * The timetable API applies the appropriate class access rules for teachers,
 * learners, and parents, so this component only needs to request today's day.
 */
export default function TodaysSchedule({
  title = "Today's Schedule",
  emptyMessage = "No classes are scheduled for today.",
  showClass = false,
  showTeacher = true,
  viewAllHref,
  className = "",
}: TodaysScheduleProps) {
  const [entries, setEntries] = useState<TimetableEntry[]>([]);
  const [today] = useState(currentDay);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    const token = localStorage.getItem("el_token");
    const controller = new AbortController();
    let active = true;

    async function loadSchedule() {
      try {
        if (!token) {
          throw new Error("Sign in to view your schedule.");
        }

        const response = await fetch(`/api/timetable?day=${today.value}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        const data = (await response.json()) as {
          success?: boolean;
          data?: TimetableEntry[];
          error?: string;
        };

        if (!response.ok || !data.success) {
          throw new Error(data.error || "Could not load today's schedule.");
        }

        if (active) {
          setEntries(Array.isArray(data.data) ? data.data : []);
        }
      } catch (loadError) {
        if (active) {
          console.error("Today's schedule error:", loadError);
          setEntries([]);
          setError("We couldn't load today's schedule. Please try again.");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    loadSchedule();

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadCount, today.value]);

  function retrySchedule() {
    setEntries([]);
    setError(null);
    setLoading(true);
    setReloadCount((count) => count + 1);
  }

  const schedule = useMemo(
    () => [...entries].sort((a, b) => timeInMinutes(a.startTime) - timeInMinutes(b.startTime)),
    [entries]
  );

  return (
    <section className={`bg-white rounded-2xl shadow-sm border border-slate-100 p-6 ${className}`}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h2 className="font-bold text-lg text-slate-800 flex items-center gap-2">
            <span aria-hidden="true">📅</span> {title}
          </h2>
          {today && <p className="text-xs text-slate-400 mt-1">{today.label}</p>}
        </div>
        {viewAllHref && (
          <Link
            href={viewAllHref}
            className="shrink-0 text-xs font-semibold text-primary-600 hover:text-primary-700"
          >
            Full timetable →
          </Link>
        )}
      </div>

      {loading ? (
        <div className="space-y-3" aria-label="Loading today's schedule">
          {[1, 2, 3].map((item) => (
            <div key={item} className="h-20 rounded-xl bg-slate-100 animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <div className="py-6 text-center rounded-xl bg-slate-50">
          <p className="text-sm text-slate-500">{error}</p>
          <button
            type="button"
            onClick={retrySchedule}
            className="mt-2 text-sm font-semibold text-primary-600 hover:text-primary-700"
          >
            Try again
          </button>
        </div>
      ) : schedule.length === 0 ? (
        <div className="py-7 text-center rounded-xl border-2 border-dashed border-slate-200">
          <div className="text-3xl" aria-hidden="true">🌤️</div>
          <p className="mt-2 text-sm text-slate-500">{emptyMessage}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {schedule.map((entry) => {
            const teacher = teacherName(entry);
            const status = statusStyles[scheduleStatus(entry)];
            const details = [
              showClass && entry.className ? `🏫 ${entry.className}` : null,
              showTeacher && teacher ? teacher : null,
              entry.room ? `📍 ${entry.room}` : null,
            ].filter(Boolean);

            return (
              <div
                key={entry.id}
                className={`p-4 rounded-xl border-l-4 ${entry.color || subjectColor(entry.subjectName)} flex items-start justify-between gap-3`}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-sm text-slate-700">
                    {entry.subjectName || "Class period"}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {formatTimeSlot(entry.startTime, entry.endTime)}
                    {details.length > 0 ? ` • ${details.join(" • ")}` : ""}
                  </p>
                  {entry.notes && (
                    <p className="mt-1 text-xs italic text-slate-400">{entry.notes}</p>
                  )}
                </div>
                <span className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-semibold ${status.className}`}>
                  {status.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
