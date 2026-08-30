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
} from "drizzle-orm/pg-core";

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
  name: varchar("name", { length: 50 }).notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Terms ── */
export const terms = pgTable("terms", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: termEnum("name").notNull(),
  academicYearId: uuid("academic_year_id").notNull().references(() => academicYears.id),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  isCurrent: boolean("is_current").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Departments ── */
export const departments = pgTable("departments", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  description: text("description"),
  headId: uuid("head_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Classes ── */
export const classes = pgTable("classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  level: levelEnum("level").notNull(),
  capacity: integer("capacity").default(40),
  classTeacherId: uuid("class_teacher_id"),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Subjects ── */
export const subjects = pgTable("subjects", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 100 }).notNull(),
  code: varchar("code", { length: 20 }),
  departmentId: uuid("department_id").references(() => departments.id),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Teacher-Class assignments ── */
export const teacherClasses = pgTable("teacher_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  teacherId: uuid("teacher_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  subjectId: uuid("subject_id").notNull().references(() => subjects.id),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Learner-Class enrollment ── */
export const learnerClasses = pgTable("learner_classes", {
  id: uuid("id").primaryKey().defaultRandom(),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  academicYearId: uuid("academic_year_id").references(() => academicYears.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Parent-Learner relationship ── */
export const parentLearners = pgTable("parent_learners", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentId: uuid("parent_id").notNull().references(() => users.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  relationship: varchar("relationship", { length: 50 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Assignments ── */
export const assignments = pgTable("assignments", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/* ── Submissions ── */
export const submissions = pgTable("submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: uuid("assignment_id").notNull().references(() => assignments.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  content: text("content"),
  attachments: jsonb("attachments"),
  status: submissionStatusEnum("status").notNull().default("pending"),
  score: integer("score"),
  maxScore: integer("max_score"),
  percentage: integer("percentage"),
  feedback: text("feedback"),
  submittedAt: timestamp("submitted_at"),
  gradedAt: timestamp("graded_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

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
});

/* ── Quizzes ── */
export const quizzes = pgTable("quizzes", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

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
  quizId: uuid("quiz_id").notNull().references(() => quizzes.id),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  answers: jsonb("answers"),
  score: integer("score"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

/* ── Announcements ── */
export const announcements = pgTable("announcements", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  authorId: uuid("author_id").notNull().references(() => users.id),
  classId: uuid("class_id").references(() => classes.id),
  isPinned: boolean("is_pinned").default(false),
  isPublic: boolean("is_public").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Notifications ── */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  type: notificationTypeEnum("type").notNull(),
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  isRead: boolean("is_read").notNull().default(false),
  link: text("link"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Attendance ── */
export const attendance = pgTable("attendance", {
  id: uuid("id").primaryKey().defaultRandom(),
  learnerId: uuid("learner_id").notNull().references(() => users.id),
  classId: uuid("class_id").notNull().references(() => classes.id),
  date: date("date").notNull(),
  isPresent: boolean("is_present").notNull().default(true),
  note: text("note"),
  markedById: uuid("marked_by_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Timetable (weekly class schedule) ── */
export const timetableEntries = pgTable("timetable_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

/* ── Messages ── */
export const messages = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  senderId: uuid("sender_id").notNull().references(() => users.id),
  receiverId: uuid("receiver_id").notNull().references(() => users.id),
  content: text("content").notNull(),
  isRead: boolean("is_read").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Activity Logs (Audit) ── */
export const activityLogs = pgTable("activity_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id),
  action: varchar("action", { length: 100 }).notNull(),
  details: text("details"),
  ipAddress: varchar("ip_address", { length: 50 }),
  entityType: varchar("entity_type", { length: 100 }),
  entityId: uuid("entity_id"),
  description: text("description"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Dashboard Card Overrides ── */
export const dashboardCardOverrides = pgTable("dashboard_card_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
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
});

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
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  imageUrl: text("image_url").notNull(),
  category: varchar("category", { length: 100 }),
  isPublic: boolean("is_public").default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── News / Events ── */
export const news = pgTable("news", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  isEvent: boolean("is_event").default(false),
  eventDate: timestamp("event_date"),
  isPublished: boolean("is_published").default(false),
  authorId: uuid("author_id").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── FAQ ── */
export const faqs = pgTable("faqs", {
  id: uuid("id").primaryKey().defaultRandom(),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  orderIndex: integer("order_index").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

/* ── Downloads ── */
export const downloads = pgTable("downloads", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: varchar("title", { length: 255 }).notNull(),
  description: text("description"),
  fileUrl: text("file_url").notNull(),
  category: varchar("category", { length: 100 }),
  downloadCount: integer("download_count").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
