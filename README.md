# 🎓 EasyLearn (EL) — City Best International School Montessori

A full-stack school learning management system built with Next.js, PostgreSQL, and Drizzle ORM.

## 🚀 Deploy to Get a Permanent Link

### Option A: Deploy to Vercel + Neon (Recommended — FREE)

This is the fastest way to get a permanent PWA link.

#### Step 1: Get a Free PostgreSQL Database

1. Go to [https://neon.tech](https://neon.tech) and sign up (free)
2. Create a new project called `easylearn`
3. Copy the connection string — it looks like:
   ```
   postgresql://username:password@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

#### Step 2: Push Code to GitHub

1. Create a new repo on [GitHub](https://github.com/new) called `easylearn`
2. Push this code:
   ```bash
   git init
   git add .
   git commit -m "EasyLearn v1.0"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/easylearn.git
   git push -u origin main
   ```

#### Step 3: Deploy to Vercel

1. Go to [https://vercel.com](https://vercel.com) and sign in with GitHub
2. Click **"Add New Project"**
3. Import your `easylearn` repo
4. Add these **Environment Variables**:
   - `DATABASE_URL` = your Neon connection string from Step 1
   - `JWT_SECRET` = any long random string (e.g. `my-super-secret-jwt-key-easylearn-2024`)
5. Click **Deploy**
6. Wait 2-3 minutes for the build

#### Step 4: Set Up Database Tables

After deploying, run this in your terminal:
```bash
DATABASE_URL="your-neon-connection-string" npx drizzle-kit push
```

Then open your deployed app and go to `/api/seed` (POST request) to create demo data.

#### Step 4b: Keep migrations up to date

`drizzle-kit push` creates the base schema, but every feature since then ships a numbered SQL
file in `drizzle/`. Apply them after deploys:

```bash
# all pending migrations (idempotent - safe to re-run)
DATABASE_URL="your-neon-connection-string" node run-migration.js

# a single file
DATABASE_URL="your-neon-connection-string" node run-migration.js 0006_user_identity_columns.sql
```

| File | What it adds |
| --- | --- |
| `0001_assignment_grading.sql` | Auto-grading: questions, submissions, corrections |
| `0002_optional_email.sql` | Optional email + username login |
| `0003_timetable.sql` | `timetable_entries` |
| `0004_dashboard_overrides.sql` | `dashboard_card_overrides` (manual dashboard card values) |
| `0005_activity_enhancements.sql` | `activity_logs.entity_type/entity_id/description` (admin activity feed) |
| `0006_user_identity_columns.sql` | `users.username`, `users.must_change_password` (these existed in `src/db/schema.ts` but in no migration) |
| `0007_quiz_images.sql` | `quiz_questions.image_url` (Kahoot question images) |
| `0008_easyai_grading.sql` | EasyAI: `assignments.ai_grading_enabled`/`ai_max_marks`, `submissions.graded_by`/`ai_report` |

Notes:

- Check `GET /api/health` any time: it reports `databaseConnected`, `jwtSecretConfigured`, and
  `optionalMigrations` (`dashboard_card_overrides`, `activity_logs_enrichment`,
  `optional_user_columns`, `quiz_question_images`) with a `migrationWarnings` entry per missing
  file.
- The dashboards are **degrade-instead-of-crash**: a missing migration disables that section and
  shows a warning banner on the admin dashboard, it no longer returns a 500 blank page.
- On request, EasyLearn will try to create the *optional* objects above itself using idempotent
  DDL (logged as "created automatically"). Set `AUTO_SCHEMA_REPAIR=false` if your database role is
  not allowed to run DDL.
- `0004`/`0005` used to contain shell-escaped `\"` quotes, so they failed with a syntax error that
  the old runner swallowed. The files are fixed and `run-migration.js` now exits non-zero whenever
  a statement genuinely could not be applied.
- `0007` was missing from `drizzle/meta/_journal.json`, so `drizzle-kit` never applied it. Because
  `quiz_questions.image_url` is declared in `src/db/schema.ts`, Drizzle listed the column in every
  quiz insert and read, so **every** quiz creation and quiz page failed with
  `column "image_url" of relation "quiz_questions" does not exist` (SQLSTATE 42703) and learners
  saw an empty quiz list. It is registered in the journal now, and the quiz routes also repair it
  on demand through `ensureQuizImageColumn()`.

#### Quizzes and grading

- **EasyAI — automated assignment grading.** When creating an assignment
  (`/dashboard/teacher/assignments`), teachers can switch on **✨ Grade instantly with EasyAI**
  and set the **total maximum marks the AI may allocate** (e.g. 50 → every learner is graded as
  `x/50`). The moment a learner submits, `POST /api/assignments/[id]/submit` runs the EasyAI
  engine (`src/lib/easyai.ts`) server-side — no external API, deterministic and instant:
  - **Free-text / file submissions** are analysed against the assignment brief (relevance to the
    topic, depth, structure, language, vocabulary, attached files) and marked out of the
    teacher's total.
  - **Question-based assignments** keep exact-match grading for objective questions, while
    EasyAI awards partial credit on essays / short answers; the result is scaled to the
    teacher's total.
  - The score, percentage and a written feedback report are stored on the submission
    (`score`, `max_score`, `percentage`, `graded_by = 'easyai'`, `ai_report`), so the marks show
    up **immediately** on the learner's grade page with an ✨ EasyAI badge and a marking
    breakdown. A teacher can still review and re-grade any EasyAI submission; the manual grade
    then replaces the AI's.
- **Publishing.** A quiz is only visible to learners once it is published. The teacher's
  *Create Quiz* form publishes by default (uncheck *"Publish to learners immediately"* to keep a
  draft), and every quiz card has a one-click **Publish / Unpublish** button. Publishing requires
  at least one question.
- **Visibility.** Learners see published quizzes set for a class they are enrolled in
  (`learner_classes`). If a school has recorded no enrollments at all, the list falls back to every
  published quiz rather than showing nothing.
- **Kahoot game.** `/dashboard/learner/quizzes/[id]` runs the quiz as a timed game: per-question
  countdown, four coloured answer tiles, instant right/wrong feedback from
  `POST /api/quizzes/[id]/check` (correct answers are never sent to the learner up front), a speed
  bonus, a streak counter and a class podium. The graded score is still written by
  `PUT /api/quizzes/[id]/attempt`.
- **Grading assignments.** On `/dashboard/teacher/assignments/[id]`, *Grade* opens a panel that
  shows what the learner actually wrote, awards marks per question (or a single score for written
  work), and saves feedback. `POST /api/submissions/[id]/grade` always records `score`, `max_score`
  **and** `percentage` - manual grading used to leave the last two NULL, which showed up as
  `82/null (null%)` for the teacher and averaged to 0% in the learner's grade book. Re-grading is
  allowed and does not award XP twice.

#### Step 5: Your Permanent PWA Link! 🎉

Your app will be live at: `https://easylearn-xxx.vercel.app`

This link is **permanent** — it will never expire. You can install it as a PWA on any phone.

---

### Option B: Deploy to Railway (Alternative)

1. Go to [https://railway.app](https://railway.app)
2. Create a new project → Deploy from GitHub
3. Add a PostgreSQL database from the Railway dashboard
4. Set environment variables: `DATABASE_URL`, `JWT_SECRET`
5. Railway will give you a permanent URL

---

## 📱 Installing the PWA

Once deployed, open the permanent URL on your phone:

**iPhone:** Safari → Share button → "Add to Home Screen"
**Android:** Chrome → Three dots menu → "Install app"

---

## 🔑 Demo Accounts

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@cbism.edu | admin123 |
| Teacher | teacher@cbism.edu | teacher123 |
| Parent | parent@cbism.edu | parent123 |
| Learner | learner@cbism.edu | learner123 |

---

## 🛠 Tech Stack

- **Frontend:** Next.js 16, React 19, TypeScript, Tailwind CSS 4
- **Backend:** Next.js API Routes
- **Database:** PostgreSQL + Drizzle ORM
- **Auth:** JWT (jose) + bcrypt
- **PWA:** Service Worker + Web App Manifest

## 📁 Project Structure

```
src/
├── app/
│   ├── api/                    # All API routes
│   │   ├── auth/               # Login, register, logout, me
│   │   ├── users/              # CRUD users + password reset
│   │   ├── assignments/        # Create, list, update, delete
│   │   ├── submissions/        # Submit + grade
│   │   ├── quizzes/            # Create quizzes + auto-grade
│   │   ├── resources/          # Study materials
│   │   ├── announcements/      # School announcements
│   │   ├── attendance/         # Mark + view attendance
│   │   ├── classes/            # Class management
│   │   ├── subjects/           # Subject management
│   │   ├── departments/        # Department management
│   │   ├── grades/             # Grade aggregation
│   │   ├── messages/           # Chat system
│   │   ├── notifications/      # In-app notifications
│   │   ├── reports/            # Analytics
│   │   ├── enrollments/        # Learner enrollment
│   │   ├── teacher-classes/    # Teacher assignments
│   │   ├── parent-learners/    # Parent-child links
│   │   ├── academic-years/     # Academic year management
│   │   ├── terms/              # Term management
│   │   └── seed/               # Database seeding
│   ├── dashboard/
│   │   ├── admin/              # Full admin panel (12 pages)
│   │   ├── teacher/            # Teacher tools (10 pages)
│   │   ├── learner/            # Learner portal (9 pages)
│   │   └── parent/             # Parent portal (9 pages)
│   └── (website pages)         # Public school website
├── components/
│   ├── admin/                  # Admin components
│   ├── dashboard/              # Shared dashboard shell
│   └── website/                # Public website components
├── db/
│   ├── schema.ts               # 25+ database tables
│   └── index.ts                # Database connection
└── lib/
    ├── auth.ts                 # JWT + bcrypt helpers
    └── api-helpers.ts          # Response helpers
```

## Environment Variables

```env
DATABASE_URL=postgresql://user:pass@host:5432/dbname
JWT_SECRET=your-secret-key
```
