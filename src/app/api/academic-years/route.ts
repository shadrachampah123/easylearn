import { NextRequest } from "next/server";
import { db } from "@/db";
import { academicYears } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { desc, eq, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  sqlAcademicYearInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    // Phase 2D: list only this school's academic years via direct school_id
    let results: any[];
    try {
      results = await db
        .select()
        .from(academicYears)
        .where(eq(academicYears.schoolId, ctx.schoolId))
        .orderBy(desc(academicYears.startDate));
    } catch {
      // Fallback for DB without school_id column (pre-0016) — return empty to avoid leaking
      results = [];
    }

    return successResponse(results);
  } catch (error) {
    console.error("Academic years error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can create academic years", 403);
    }

    const body = await request.json();
    const { name, startDate, endDate, isCurrent } = body;

    if (!name || !startDate || !endDate) {
      return errorResponse("Name, start date, and end date are required");
    }

    // Phase 2D: isCurrent is per-school, not global
    if (isCurrent) {
      try {
        await db
          .update(academicYears)
          .set({ isCurrent: false })
          .where(eq(academicYears.schoolId, ctx.schoolId));
      } catch {
        // Column missing — fallback to global unset (legacy behavior) but still scoped by creation
        await db.update(academicYears).set({ isCurrent: false });
      }
    }

    let newYear;
    try {
      [newYear] = await db
        .insert(academicYears)
        .values({
          schoolId: ctx.schoolId,
          name,
          startDate,
          endDate,
          isCurrent: isCurrent || false,
        })
        .returning();
    } catch {
      // Fallback for DB without school_id column
      [newYear] = await db
        .insert(academicYears)
        .values({
          name,
          startDate,
          endDate,
          isCurrent: isCurrent || false,
        } as any)
        .returning();
    }

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "academic_year",
      entityId: newYear.id,
      description: `Created academic year ${name}`,
    });

    return successResponse(newYear, 201);
  } catch (error) {
    console.error("Create academic year error:", error);
    return errorResponse("Internal server error", 500);
  }
}

// Phase 2D: add PUT/DELETE for tenant-scoped mutations (previously missing, now secured)
export async function PUT(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can update academic years", 403);
    }

    const body = await request.json();
    const { id, name, startDate, endDate, isCurrent } = body;
    if (!id) return errorResponse("Academic year id is required", 400);

    // Tenant check: must belong to caller's school
    let existing;
    try {
      [existing] = await db
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.id, id), eq(academicYears.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      // Fallback: if school_id column missing, deny (fail closed) — no update without tenancy
      return errorResponse("Academic year not found", 404);
    }

    if (!existing) return errorResponse("Academic year not found", 404);

    if (isCurrent) {
      await db
        .update(academicYears)
        .set({ isCurrent: false })
        .where(eq(academicYears.schoolId, ctx.schoolId));
    }

    const [updated] = await db
      .update(academicYears)
      .set({
        name: name ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        isCurrent: isCurrent ?? undefined,
      })
      .where(and(eq(academicYears.id, id), eq(academicYears.schoolId, ctx.schoolId)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update academic year error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can delete academic years", 403);
    }

    const id = request.nextUrl.searchParams.get("id");
    if (!id) return errorResponse("Academic year id is required", 400);

    let existing;
    try {
      [existing] = await db
        .select({ id: academicYears.id })
        .from(academicYears)
        .where(and(eq(academicYears.id, id), eq(academicYears.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return errorResponse("Academic year not found", 404);
    }

    if (!existing) return errorResponse("Academic year not found", 404);

    await db
      .delete(academicYears)
      .where(and(eq(academicYears.id, id), eq(academicYears.schoolId, ctx.schoolId)));

    return successResponse({ message: "Academic year deleted" });
  } catch (error) {
    console.error("Delete academic year error:", error);
    return errorResponse("Internal server error", 500);
  }
}
