"use client";

export const TIMETABLE_DAYS = [
  { value: "monday", label: "Monday", short: "Mon" },
  { value: "tuesday", label: "Tuesday", short: "Tue" },
  { value: "wednesday", label: "Wednesday", short: "Wed" },
  { value: "thursday", label: "Thursday", short: "Thu" },
  { value: "friday", label: "Friday", short: "Fri" },
  { value: "saturday", label: "Saturday", short: "Sat" },
  { value: "sunday", label: "Sunday", short: "Sun" },
] as const;

export type DayValue = (typeof TIMETABLE_DAYS)[number]["value"];

export interface TimetableEntry {
  id: string;
  classId: string;
  className: string | null;
  subjectId: string | null;
  subjectName: string | null;
  teacherId: string | null;
  teacherFirstName: string | null;
  teacherLastName: string | null;
  dayOfWeek: DayValue;
  startTime: string;
  endTime: string;
  room: string | null;
  color: string | null;
  notes: string | null;
}

const GRID_COLUMN_CLASSES: Record<number, string> = {
  1: "lg:grid-cols-1",
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
  7: "lg:grid-cols-7",
};

const SUBJECT_COLORS = [
  "bg-blue-50 border-blue-200 text-blue-700",
  "bg-green-50 border-green-200 text-green-700",
  "bg-purple-50 border-purple-200 text-purple-700",
  "bg-orange-50 border-orange-200 text-orange-700",
  "bg-pink-50 border-pink-200 text-pink-700",
  "bg-cyan-50 border-cyan-200 text-cyan-700",
  "bg-yellow-50 border-yellow-200 text-yellow-700",
  "bg-indigo-50 border-indigo-200 text-indigo-700",
  "bg-teal-50 border-teal-200 text-teal-700",
  "bg-rose-50 border-rose-200 text-rose-700",
];

export function subjectColor(subject?: string | null): string {
  if (!subject) return "bg-slate-50 border-slate-200 text-slate-700";
  let hash = 0;
  for (let i = 0; i < subject.length; i++) {
    hash = (hash * 31 + subject.charCodeAt(i)) % 100000;
  }
  return SUBJECT_COLORS[hash % SUBJECT_COLORS.length];
}

export function formatTimeSlot(startTime: string, endTime: string): string {
  return `${startTime.slice(0, 5)}-${endTime.slice(0, 5)}`;
}

export function teacherName(entry: TimetableEntry): string | null {
  const name = [entry.teacherFirstName, entry.teacherLastName].filter(Boolean).join(" ");
  return name || null;
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":");
  return Number(hours) * 60 + Number(minutes);
}

interface TimetableGridProps {
  entries: TimetableEntry[];
  loading?: boolean;
  emptyMessage?: string;
  showClass?: boolean;
  showTeacher?: boolean;
  onEdit?: (entry: TimetableEntry) => void;
  onDelete?: (entry: TimetableEntry) => void;
  onAdd?: () => void;
}

export default function TimetableGrid({
  entries,
  loading = false,
  emptyMessage = "No periods have been scheduled yet.",
  showClass = false,
  showTeacher = true,
  onEdit,
  onDelete,
  onAdd,
}: TimetableGridProps) {
  if (loading) {
    return (
      <div className="grid lg:grid-cols-5 gap-4">
        {TIMETABLE_DAYS.slice(0, 5).map((day) => (
          <div key={day.value} className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-3 bg-slate-200 animate-pulse" />
            <div className="p-3 space-y-3">
              <div className="h-16 bg-slate-100 rounded-xl animate-pulse" />
              <div className="h-16 bg-slate-100 rounded-xl animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const usedDays = TIMETABLE_DAYS.filter((day) =>
    entries.some((entry) => entry.dayOfWeek === day.value)
  );
  // Show the weekdays by default, but expand when weekend periods exist.
  const days = usedDays.length > 5 ? TIMETABLE_DAYS : TIMETABLE_DAYS.slice(0, 5);
  const gridColumns =
    GRID_COLUMN_CLASSES[days.length] ?? GRID_COLUMN_CLASSES[5];

  return (
    <div className={`grid gap-4 md:grid-cols-2 ${gridColumns}`}>
      {days.map((day) => {
        const dayEntries = entries
          .filter((entry) => entry.dayOfWeek === day.value)
          .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

        return (
          <div
            key={day.value}
            className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden flex flex-col"
          >
            <div className="p-3 bg-gradient-to-r from-primary-500 to-primary-600 text-white text-center">
              <p className="font-bold text-sm">{day.label}</p>
              <p className="text-[11px] text-white/70">{dayEntries.length} period{dayEntries.length === 1 ? "" : "s"}</p>
            </div>
            <div className="p-3 space-y-3 flex-1">
              {dayEntries.length === 0 ? (
                <div className="h-full min-h-24 flex flex-col items-center justify-center text-center rounded-xl border-2 border-dashed border-slate-200 text-slate-400">
                  <span className="text-2xl">😴</span>
                  <p className="text-xs mt-1">No classes</p>
                  {onAdd && (
                    <button
                      onClick={onAdd}
                      className="mt-2 text-xs font-semibold text-primary-600 hover:text-primary-700"
                    >
                      + Add period
                    </button>
                  )}
                </div>
              ) : (
                dayEntries.map((entry) => {
                  const teacher = teacherName(entry);
                  const meta = [teacher, entry.room].filter(Boolean).join(" • ");

                  return (
                    <div
                      key={entry.id}
                      className={`p-3 rounded-xl border-2 ${entry.color || subjectColor(entry.subjectName)} group relative`}
                    >
                      <p className="text-[10px] font-mono text-slate-400">
                        {formatTimeSlot(entry.startTime, entry.endTime)}
                      </p>
                      <p className="font-semibold text-sm mt-1">
                        {entry.subjectName || "Class period"}
                      </p>
                      {showClass && entry.className && (
                        <p className="text-[10px] text-slate-500 mt-0.5">🏫 {entry.className}</p>
                      )}
                      {showTeacher && meta && (
                        <p className="text-[10px] text-slate-500 mt-1">{meta}</p>
                      )}
                      {entry.notes && (
                        <p className="text-[10px] italic text-slate-400 mt-1">{entry.notes}</p>
                      )}
                      {(onEdit || onDelete) && (
                        <div className="mt-2 flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                          {onEdit && (
                            <button
                              onClick={() => onEdit(entry)}
                              className="flex-1 py-1 rounded-lg bg-white/70 text-[11px] font-semibold text-slate-600 hover:bg-white"
                            >
                              Edit
                            </button>
                          )}
                          {onDelete && (
                            <button
                              onClick={() => onDelete(entry)}
                              className="flex-1 py-1 rounded-lg bg-white/70 text-[11px] font-semibold text-red-600 hover:bg-white"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
