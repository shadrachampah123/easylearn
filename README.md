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
