import { db } from "@/db";
import { users, academicYears, terms, departments, classes, subjects, announcements, faqs, achievements } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { sql } from "drizzle-orm";

export async function POST() {
  try {
    // Check if already seeded
    const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
    if (existingUsers.length > 0) {
      return successResponse({ message: "Database already seeded" });
    }

    const adminHash = await hashPassword("admin123");
    const teacherHash = await hashPassword("teacher123");
    const parentHash = await hashPassword("parent123");
    const learnerHash = await hashPassword("learner123");

    // Create users
    const [admin] = await db.insert(users).values({
      email: "admin@cbism.edu",
      passwordHash: adminHash,
      role: "super_admin",
      firstName: "Admin",
      lastName: "CBISM",
      phone: "+233000000000",
      emailVerified: true,
    }).returning();

    const [teacher1] = await db.insert(users).values({
      email: "teacher@cbism.edu",
      passwordHash: teacherHash,
      role: "teacher",
      firstName: "Grace",
      lastName: "Mensah",
      phone: "+233111111111",
      gender: "female",
      emailVerified: true,
    }).returning();

    const [parent1] = await db.insert(users).values({
      email: "parent@cbism.edu",
      passwordHash: parentHash,
      role: "parent",
      firstName: "Kwame",
      lastName: "Asante",
      phone: "+233222222222",
      gender: "male",
      emailVerified: true,
    }).returning();

    const [learner1] = await db.insert(users).values({
      email: "learner@cbism.edu",
      passwordHash: learnerHash,
      role: "learner",
      firstName: "Ama",
      lastName: "Asante",
      phone: "+233333333333",
      gender: "female",
      emailVerified: true,
    }).returning();

    // Academic year
    const [ay] = await db.insert(academicYears).values({
      name: "2024/2025",
      startDate: "2024-09-01",
      endDate: "2025-07-31",
      isCurrent: true,
    }).returning();

    // Terms
    await db.insert(terms).values([
      { name: "term_1", academicYearId: ay.id, startDate: "2024-09-01", endDate: "2024-12-20", isCurrent: true },
      { name: "term_2", academicYearId: ay.id, startDate: "2025-01-06", endDate: "2025-04-10" },
      { name: "term_3", academicYearId: ay.id, startDate: "2025-04-28", endDate: "2025-07-31" },
    ]);

    // Departments
    const [sciDept] = await db.insert(departments).values([
      { name: "Sciences", description: "Science department" },
      { name: "Languages", description: "Language arts department" },
      { name: "Mathematics", description: "Mathematics department" },
      { name: "Social Studies", description: "Social studies department" },
      { name: "Creative Arts", description: "Arts and creativity department" },
    ]).returning();

    // Classes
    const [classP1] = await db.insert(classes).values([
      { name: "Nursery 1", level: "nursery", capacity: 25, academicYearId: ay.id },
      { name: "Nursery 2", level: "nursery", capacity: 25, academicYearId: ay.id },
      { name: "KG 1", level: "kindergarten", capacity: 30, academicYearId: ay.id },
      { name: "KG 2", level: "kindergarten", capacity: 30, academicYearId: ay.id },
      { name: "Primary 1", level: "primary", capacity: 35, classTeacherId: teacher1.id, academicYearId: ay.id },
      { name: "Primary 2", level: "primary", capacity: 35, academicYearId: ay.id },
      { name: "Primary 3", level: "primary", capacity: 35, academicYearId: ay.id },
      { name: "JHS 1", level: "junior_high", capacity: 40, academicYearId: ay.id },
      { name: "JHS 2", level: "junior_high", capacity: 40, academicYearId: ay.id },
      { name: "JHS 3", level: "junior_high", capacity: 40, academicYearId: ay.id },
    ]).returning();

    // Subjects
    await db.insert(subjects).values([
      { name: "English Language", code: "ENG", departmentId: sciDept.id },
      { name: "Mathematics", code: "MATH", departmentId: sciDept.id },
      { name: "Integrated Science", code: "SCI", departmentId: sciDept.id },
      { name: "Social Studies", code: "SOC", departmentId: sciDept.id },
      { name: "French", code: "FRE", departmentId: sciDept.id },
      { name: "ICT", code: "ICT", departmentId: sciDept.id },
      { name: "Creative Arts", code: "ART", departmentId: sciDept.id },
      { name: "Religious & Moral Education", code: "RME", departmentId: sciDept.id },
      { name: "Ghanaian Language", code: "GHL", departmentId: sciDept.id },
      { name: "Physical Education", code: "PE", departmentId: sciDept.id },
    ]);

    // Announcements
    await db.insert(announcements).values([
      {
        title: "Welcome to the New Academic Year!",
        content: "We are excited to welcome all learners, parents, and teachers to the 2024/2025 academic year at CBISM. Let's make this year the best yet!",
        authorId: admin.id,
        isPublic: true,
        isPinned: true,
      },
      {
        title: "Parent-Teacher Conference",
        content: "The first parent-teacher conference will be held on October 15, 2024. Please mark your calendars and plan to attend.",
        authorId: admin.id,
        isPublic: true,
      },
    ]);

    // FAQs
    await db.insert(faqs).values([
      { question: "What are the school hours?", answer: "School runs from 7:30 AM to 2:30 PM, Monday to Friday.", orderIndex: 1 },
      { question: "What is the admission process?", answer: "Visit our admissions page, fill out the application form, and submit with required documents. An entrance assessment may be required.", orderIndex: 2 },
      { question: "Do you offer transportation?", answer: "Yes, CBISM provides school bus services for various routes. Contact the school office for available routes and fees.", orderIndex: 3 },
      { question: "What extracurricular activities are available?", answer: "We offer sports, music, drama, debate, coding club, art club, and many more!", orderIndex: 4 },
      { question: "How can parents monitor their child's progress?", answer: "Parents can log in to EasyLearn to view grades, attendance, assignments, and communicate with teachers.", orderIndex: 5 },
    ]);

    // Achievements
    await db.insert(achievements).values([
      { name: "First Login", description: "Logged in for the first time!", icon: "🌟", pointsRequired: 0 },
      { name: "Assignment Ace", description: "Completed 10 assignments", icon: "📝", pointsRequired: 100 },
      { name: "Quiz Master", description: "Scored 100% on 5 quizzes", icon: "🏆", pointsRequired: 500 },
      { name: "Bookworm", description: "Downloaded 20 study materials", icon: "📚", pointsRequired: 200 },
      { name: "Perfect Attendance", description: "100% attendance for a month", icon: "⭐", pointsRequired: 300 },
    ]);

    return successResponse({ message: "Database seeded successfully", users: { admin: admin.email, teacher: teacher1.email, parent: parent1.email, learner: learner1.email } }, 201);
  } catch (error) {
    console.error("Seed error:", error);
    return errorResponse("Failed to seed database: " + String(error), 500);
  }
}
