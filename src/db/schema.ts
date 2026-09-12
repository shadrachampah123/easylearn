import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  date,
  jsonb,
  unique,
  index,
  check,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";

/* ── Enums ── */
export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "school_admin",
  "head_teacher",
  "teacher",
  "parent",
  "learner",
]);

export const genderEnum = pgEnum("gender", ["male", "female", "other"]);

export const levelEnum = pgEnum("level", [
  "nursery",
  "kindergarten",
  "primary",
  "junior_high",
]);

export const termEnum = pgEnum("term_name", ["term_1", "term_2", "term_3"]);

export const assignmentStatusEnum = pgEnum("assignment_status", [
  "draft",
  "published",
  "closed",
]);

export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "submitted",
  "late",
  "graded",
]);

export const notificationTypeEnum = pgEnum("notification_type", [
  "assignment",
  "quiz",
  "announcement",
  "grade",
  "reminder",
  "system",
]);

export const resourceTypeEnum = pgEnum("resource_type", [
  "pdf",
  "docx",
  "pptx",
  "image",
  "video",
  "audio",
  "link",
  "zip",
]);

export const quizQuestionTypeEnum = pgEnum("quiz_question_type", [
  "mcq",
  "true_false",
  "fill_blank",
  "matching",
  "short_answer",
  "essay",
]);

export const timetableDayEnum = pgEnum("timetable_day", [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
]);

export const dashboardRoleEnum = pgEnum("dashboard_role", [
  "admin",
  "teacher",
  "learner",
  "parent",
  "global",
]);

export const cardScopeTypeEnum = pgEnum("card_scope_type", [
  "global",
  "role",
  "class",
  "learner",
  "parent",
  "teacher",
  "user",
]);

/* ── Users ── */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: varchar("username", { length: 100 }).unique(), 
  email: varchar("email", { length: 255 }).unique(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("learner"),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 20 }),
  avatarUrl: text("avatar_url"),
  gender: genderEnum("gender"),
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(false), 
  emailVerified: boolean("email_verified").notNull().default(false),
  lastLogin: timestamp("last_login"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/* ── Academic Years ── */
export const academicYears = pgTable("academic_years", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  name: varchar("name", { length: 50 }).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("academic_years_school_idx").on(table.schoolId),
  schoolNameUnique: unique("academic_years_school_name_unique").on(table.schoolId, table.name),
}));

/* ── Terms ── */
export const terms = pgTable("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  name: termEnum("name").notNull(),
  academicYearId: uuid("academic_year_id").notNull().references(() => academicYears.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("terms_school_idx").on(table.schoolId),
}));

/* ── Departments ── */
export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  headId: uuid("head_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("departments_school_idx").on(table.schoolId),
  schoolNameUnique: unique("departments_school_name_unique").on(table.schoolId, table.name),
}));

/* ── Classes ── */
export const classes = pgTable("classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  name: varchar("name", { length: 100 }).notNull(),
  level: levelEnum("level").notNull(),
  capacity: integer("capacity").default(40),
  classTeacherId: uuid("class_teacher_id"),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("classes_school_idx").on(table.schoolId),
}));

/* ── Subjects ── */
export const subjects = pgTable("subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  name: varchar("name", { length: 100 }).notNull(),
  code: varchar("code", { length: 20 }),
  departmentId: uuid("department_id").references(() => departments.id),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("subjects_school_idx").on(table.schoolId),
}));

/* ── Teacher-Class assignments ── */
export const teacherClasses = pgTable("teacher_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("teacher_classes_school_idx").on(table.schoolId),
}));

/* ── Learner-Class enrollment ── */
export const learnerClasses = pgTable("learner_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("learner_classes_school_idx").on(table.schoolId),
}));

/* ── Parent-Learner relationship ── */
export const parentLearners = pgTable("parent_learners", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  parentId: uuid("parent_id").notNull().references(() => users.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  relationship: varchar("relationship", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("parent_learners_school_idx").on(table.schoolId),
}));

/* ── Assignments ── */
export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  instructions: text("instructions"),
  classId: uuid("class_id").notNull().references(() => classes.id),
  subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  termId: uuid("term_id").references(() => terms.id),
  status: assignmentStatusEnum("status").notNull().default("draft"),
  dueDate: timestamp("due_date"),
  maxScore: integer("max_score").default(100),
  allowLate: boolean("allow_late").default(false),
  attachments: jsonb("attachments"),
  // Teacher-controlled gate for learner file uploads. Learners may only attach
  // files to their submission when the teacher explicitly enables this.
  // (Added by drizzle/0009_file_uploads.sql.)
  allowFileUploads: boolean("allow_file_uploads").notNull().default(false),
  // EasyAI — automated grading: when enabled, learner submissions are evaluated
  // instantly by EasyAI and marked out of `aiMaxMarks` (the total the teacher
  // allows the AI to allocate) instead of waiting for manual teacher grading.
  aiGradingEnabled: boolean("ai_grading_enabled").notNull().default(false),
  aiMaxMarks: integer("ai_max_marks"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("assignments_school_idx").on(table.schoolId),
}));

/* ── Submissions ── */
export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  content: text("content"),
  attachments: jsonb("attachments"),
  status: submissionStatusEnum("status").notNull().default("pending"),
  score: integer("score"),
  maxScore: integer("max_score"),
  percentage: integer("percentage"),
  feedback: text("feedback"),
  // EasyAI audit trail: who graded ("easyai" | "teacher") and, for AI-graded
  // submissions, the full EasyAI evaluation report (criteria, strengths, tips).
  gradedBy: varchar("graded_by", { length: 20 }),
  aiReport: jsonb("ai_report"),
  submittedAt: timestamp("submitted_at"),
  gradedAt: timestamp("graded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("submissions_school_idx").on(table.schoolId),
}));

/* ── Uploaded Files ──
   Every file uploaded from a local device (assignment materials by teachers,
   submission files by learners) is registered here. The `attachments` jsonb on
   assignments/submissions references these rows by `fileId`. Files themselves
   live on disk under the upload storage directory (UPLOAD_DIR). */
export const uploadedFiles = pgTable("uploaded_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  uploaderId: uuid("uploader_id").notNull().references(() => users.id),
  purpose: varchar("purpose", { length: 30 }).notNull(), // "assignment" | "submission"
  assignmentId: uuid("assignment_id").references(() => assignments.id),
  originalName: varchar("original_name", { length: 255 }).notNull(),
  storedName: varchar("stored_name", { length: 255 }).notNull().unique(),
  mimeType: varchar("mime_type", { length: 150 }),
  category: varchar("category", { length: 20 }).notNull(), // document | image | audio | video | zip
  sizeBytes: integer("size_bytes").notNull(),
  // Where the bytes live: "local" (disk under UPLOAD_DIR) or "object" (cloud
  // object storage such as S3/R2 — stored_name then holds the object key).
  // (Added by drizzle/0010_object_storage.sql.)
  storageBackend: varchar("storage_backend", { length: 20 }).notNull().default("local"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("uploaded_files_school_idx").on(table.schoolId),
}));

/* ── Assignment Questions ── */
export const assignmentQuestions = pgTable("assignment_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id),
  questionType: quizQuestionTypeEnum("question_type").notNull().default("mcq"),
  questionText: text("question_text").notNull(),
  options: jsonb("options"),
  correctAnswer: text("correct_answer"),
  points: integer("points").default(1),
  orderIndex: integer("order_index").default(0),
  explanation: text("explanation"),
});

/* ── Assignment Answers (per-question) ── */
export const assignmentAnswers = pgTable("assignment_answers", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id").notNull().references(() => submissions.id),
  questionId: uuid("question_id").notNull().references(() => assignmentQuestions.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  answer: text("answer"),
  isCorrect: boolean("is_correct").default(false),
  pointsAwarded: integer("points_awarded").default(0),
  pointsPossible: integer("points_possible").default(0),
});

/* ── Assignment Corrections ─ */
export const assignmentCorrections = pgTable("assignment_corrections", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id),
  questionId: uuid("question_id").references(() => assignmentQuestions.id),
  correctionText: text("correction_text").notNull(),
  postedBy: uuid("posted_by").notNull().references(() => users.id),
  postedAt: timestamp("posted_at").notNull().defaultNow(),
});

/* ── Resources / Study Materials ── */
export const resources = pgTable("resources", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  type: resourceTypeEnum("type").notNull(),
  fileUrl: text("file_url"),
  fileSize: integer("file_size"),
  subjectId: uuid("subject_id").references(() => subjects.id),
  classId: uuid("class_id").references(() => classes.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  termId: uuid("term_id").references(() => terms.id),
  topic: varchar("topic", { length: 255 }),
  week: integer("week"),
  isPinned: boolean("is_pinned").default(false),
  isApproved: boolean("is_approved").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("resources_school_idx").on(table.schoolId),
}));

/* ── Quizzes ── */
export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  classId: uuid("class_id").notNull().references(() => classes.id),
  subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  termId: uuid("term_id").references(() => terms.id),
  timeLimitMinutes: integer("time_limit_minutes"),
  shuffleQuestions: boolean("shuffle_questions").default(false),
  shuffleAnswers: boolean("shuffle_answers").default(false),
  showResults: boolean("show_results").default(true),
  isPublished: boolean("is_published").default(false),
  maxAttempts: integer("max_attempts").default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("quizzes_school_idx").on(table.schoolId),
}));

/* ── Quiz Questions ── */
export const quizQuestions = pgTable("quiz_questions", {
  id: uuid("id").primaryKey().defaultRandom(),
  quizId: uuid("quiz_id").notNull().references(() => quizzes.id),
  questionType: quizQuestionTypeEnum("question_type").notNull(),
  questionText: text("question_text").notNull(),
  imageUrl: text("image_url"),
  options: jsonb("options"),
  correctAnswer: text("correct_answer"),
  points: integer("points").default(1),
  orderIndex: integer("order_index").default(0),
});

/* ── Quiz Attempts ── */
export const quizAttempts = pgTable("quiz_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  quizId: uuid("quiz_id").notNull().references(() => quizzes.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  answers: jsonb("answers"),
  score: integer("score"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  schoolIdx: index("quiz_attempts_school_idx").on(table.schoolId),
}));

/* ── Announcements ── */
export const announcements = pgTable("announcements", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  authorId: uuid("author_id").notNull().references(() => users.id),
  classId: uuid("class_id").references(() => classes.id),
  isPinned: boolean("is_pinned").default(false),
  isPublic: boolean("is_public").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("announcements_school_idx").on(table.schoolId),
}));

/* ── Notifications ── */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  userId: uuid("user_id").notNull().references(() => users.id),
  type: notificationTypeEnum("type").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  isRead: boolean("is_read").notNull().default(false),
  link: text("link"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("notifications_school_idx").on(table.schoolId),
}));

/* ── Attendance ── */
export const attendance = pgTable("attendance", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  date: date("date").notNull(),
  isPresent: boolean("is_present").notNull().default(true),
  note: text("note"),
  markedById: uuid("marked_by_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  uniqueLearnerClassDate: unique("attendance_learner_class_date_unique").on(table.learnerId, table.classId, table.date),
  schoolIdx: index("attendance_school_idx").on(table.schoolId),
}));

/* ── Login Attempts (for brute-force protection) ── */
export const loginAttempts = pgTable("login_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  identifier: varchar("identifier", { length: 255 }).notNull(), // email or username normalized
  ipAddress: varchar("ip_address", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  identifierIdx: index("login_attempts_identifier_idx").on(table.identifier),
  createdAtIdx: index("login_attempts_created_at_idx").on(table.createdAt),
}));

/* ── Attendance Duplicates Backup (for safe migration 0011) ──
   Preserves duplicate attendance records removed during unique constraint migration */
export const attendanceDuplicatesBackup = pgTable("attendance_duplicates_backup", {
  id: uuid("id").primaryKey(),
  learnerId: uuid("learner_id").notNull(),
  classId: uuid("class_id").notNull(),
  date: date("date").notNull(),
  isPresent: boolean("is_present").notNull(),
  note: text("note"),
  markedById: uuid("marked_by_id"),
  createdAt: timestamp("created_at").notNull(),
  deletedAt: timestamp("deleted_at").notNull().defaultNow(),
  deletionReason: text("deletion_reason").default("duplicate_cleanup_0011_migration"),
});

/* ── Timetable (weekly class schedule) ── */
export const timetableEntries = pgTable("timetable_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  classId: uuid("class_id")
    .notNull()
    .references(() => classes.id, { onDelete: "cascade" }),
  subjectId: uuid("subject_id").references(() => subjects.id, {
    onDelete: "set null",
  }),
  teacherId: uuid("teacher_id").references(() => users.id, {
    onDelete: "set null",
  }),
  termId: uuid("term_id").references(() => terms.id, { onDelete: "set null" }),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id, {
    onDelete: "set null",
  }),
  dayOfWeek: timetableDayEnum("day_of_week").notNull(),
  startTime: varchar("start_time", { length: 5 }).notNull(),
  endTime: varchar("end_time", { length: 5 }).notNull(),
  room: varchar("room", { length: 50 }),
  color: varchar("color", { length: 50 }),
  notes: text("notes"),
  createdBy: uuid("created_by").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("timetable_entries_school_idx").on(table.schoolId),
}));

/* ── Messages ── */
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  senderId: uuid("sender_id").notNull().references(() => users.id),
  receiverId: uuid("receiver_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("messages_school_idx").on(table.schoolId),
}));

/* ── Activity Logs (Audit) ── */
export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 100 }).notNull(),
  details: text("details"),
  ipAddress: varchar("ip_address", { length: 50 }),
  entityType: varchar("entity_type", { length: 100 }),
  entityId: uuid("entity_id"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("activity_logs_school_idx").on(table.schoolId),
}));

/* ── Dashboard Card Overrides ── */
export const dashboardCardOverrides = pgTable("dashboard_card_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  cardKey: varchar("card_key", { length: 150 }).notNull(),
  dashboardRole: dashboardRoleEnum("dashboard_role").notNull().default("global"),
  title: varchar("title", { length: 255 }),
  label: varchar("label", { length: 255 }),
  value: text("value"),
  subtitle: varchar("subtitle", { length: 255 }),
  description: text("description"),
  trend: varchar("trend", { length: 100 }),
  isVisible: boolean("is_visible").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true),
  overridePayload: jsonb("override_payload"),
  scopeType: cardScopeTypeEnum("scope_type").notNull().default("global"),
  scopeId: uuid("scope_id"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("dashboard_card_overrides_school_idx").on(table.schoolId),
}));

/* ── Achievements / Badges ── */
export const achievements = pgTable("achievements", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  icon: varchar("icon", { length: 50 }),
  pointsRequired: integer("points_required").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const learnerAchievements = pgTable("learner_achievements", {
  id: uuid("id").primaryKey().defaultRandom(),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  achievementId: uuid("achievement_id").notNull().references(() => achievements.id),
  earnedAt: timestamp("earned_at").notNull().defaultNow(),
});

/* ── Learner Points ── */
export const learnerPoints = pgTable("learner_points", {
  id: uuid("id").primaryKey().defaultRandom(),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  points: integer("points").notNull().default(0),
  reason: varchar("reason", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Gallery ── */
export const galleryItems = pgTable("gallery_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url").notNull(),
  category: varchar("category", { length: 100 }),
  isPublic: boolean("is_public").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("gallery_items_school_idx").on(table.schoolId),
}));

/* ── News / Events ── */
export const news = pgTable("news", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  isEvent: boolean("is_event").default(false),
  eventDate: timestamp("event_date"),
  isPublished: boolean("is_published").default(false),
  authorId: uuid("author_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("news_school_idx").on(table.schoolId),
}));

/* ── FAQ ── */
export const faqs = pgTable("faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  orderIndex: integer("order_index").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("faqs_school_idx").on(table.schoolId),
}));

/* ── Downloads ── */
export const downloads = pgTable("downloads", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id").references(() => schools.id),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  fileUrl: text("file_url").notNull(),
  category: varchar("category", { length: 100 }),
  downloadCount: integer("download_count").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  schoolIdx: index("downloads_school_idx").on(table.schoolId),
}));

/* ── Schools (Phase 2A — multi-school tenant root) ──
   See docs/PHASE2_MULTI_SCHOOL_ARCHITECTURE_PLAN.md (§3, §4).
   Phase 2A scope: identity + lifecycle only. Contact/branding fields, plan,
   storage quotas and custom domains arrive in later additive migrations
   (Phase 2B/2E/2H) per the architecture plan. Nothing in the application
   reads or writes this table yet — Phase 2B wires membership into auth. */
export const schools = pgTable("schools", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 150 }).notNull(),
  shortName: varchar("short_name", { length: 30 }).notNull(),
  // URL-safe tenant identifier (future {slug}.easylearn.com routing, plan §8).
  slug: varchar("slug", { length: 63 }).notNull(),
  // Lifecycle: provisioned | active | suspended | archived (plan §4.4).
  // varchar + CHECK (instead of pgEnum) so new lifecycle values are a cheap
  // additive migration, per plan §4.2.
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("schools_slug_unique").on(table.slug),
  check(
    "schools_status_check",
    sql`${table.status} in ('provisioned', 'active', 'suspended', 'archived')`
  ),
  // DNS-label-shaped slug (1–63 chars, lowercase letters/digits/hyphens,
  // no leading/trailing hyphen) so it is always subdomain-safe.
  check(
    "schools_slug_format_check",
    sql`${table.slug} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'`
  ),
  index("schools_status_idx").on(table.status),
]);

/* ── School Users (Phase 2A — school membership) ──
   `users` remains the global identity store; this table records school
   membership. A user MAY belong to multiple schools (one row per school);
   within a single school a user can appear only once. The existing
   `users.role` system is untouched; Phase 2B will read membership roles from
   here and issue them into sessions.
   Note: 'super_admin' is a PLATFORM role (plan §7) — it must never be written
   into a membership row. That exclusion is enforced by the Phase 2B
   application layer, not by the database. */
export const schoolUsers = pgTable("school_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  schoolId: uuid("school_id")
    .notNull()
    .references(() => schools.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // School-level role, reusing the existing `user_role` enum for full
  // compatibility with the current role model.
  role: userRoleEnum("role").notNull(),
  // Membership lifecycle: active | invited | disabled.
  status: varchar("status", { length: 20 }).notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // A user can be added to the same school only once. Membership in multiple
  // DIFFERENT schools is allowed (multi-school-capable from day one — the
  // single-school guard from 0013 was removed by 0014).
  unique("school_users_school_user_unique").on(table.schoolId, table.userId),
  check(
    "school_users_membership_status_check",
    sql`${table.status} in ('active', 'invited', 'disabled')`
  ),
  index("school_users_school_role_idx").on(table.schoolId, table.role, table.status),
  index("school_users_user_idx").on(table.userId),
]);

/* ── Relations (Phase 2A) ──
   Drizzle relational definitions for the two new tables. Purely additive —
   no existing query uses the relational query API yet. */
export const schoolsRelations = relations(schools, ({ many }) => ({
  members: many(schoolUsers),
}));

export const schoolUsersRelations = relations(schoolUsers, ({ one }) => ({
  school: one(schools, {
    fields: [schoolUsers.schoolId],
    references: [schools.id],
  }),
  user: one(users, {
    fields: [schoolUsers.userId],
    references: [users.id],
  }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  schoolMemberships: many(schoolUsers),
}));
