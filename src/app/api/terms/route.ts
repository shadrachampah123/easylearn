import { NextRequest } from "next/server";
import { db } from "@/db";
import { terms, academicYears } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { logActivity } from "@/lib/activity";
import { desc, eq, and } from "drizzle-orm";
import {
  guardSchoolContext,
  hasSchoolAdminRole,
  isAcademicYearInSchool,
} from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    let results: any[];
    try {
      results = await db
        .select({
          id: terms.id,
          name: terms.name,
          academicYearId: terms.academicYearId,
          startDate: terms.startDate,
          endDate: terms.endDate,
          isCurrent: terms.isCurrent,
          academicYearName: academicYears.name,
          schoolId: terms.schoolId,
        })
        .from(terms)
        .leftJoin(academicYears, eq(terms.academicYearId, academicYears.id))
        .where(eq(terms.schoolId, ctx.schoolId))
        .orderBy(desc(terms.startDate));
    } catch {
      // Fallback: no school_id column — deny to avoid leaking cross-school data
      results = [];
    }

    return successResponse(results);
  } catch (error) {
    console.error("Terms error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can create terms", 403);
    }

    const body = await request.json();
    const { name, academicYearId, startDate, endDate, isCurrent } = body;

    if (!name || !academicYearId || !startDate || !endDate) {
      return errorResponse("Name, academic year, start date, and end date are required");
    }

    // Tenant check: academic year must belong to caller's school
    if (!(await isAcademicYearInSchool(ctx.schoolId, academicYearId))) {
      return errorResponse("Academic year not found", 404);
    }

    if (isCurrent) {
      try {
        await db
          .update(terms)
          .set({ isCurrent: false })
          .where(eq(terms.schoolId, ctx.schoolId));
      } catch {
        await db.update(terms).set({ isCurrent: false });
      }
    }

    let newTerm;
    try {
      [newTerm] = await db
        .insert(terms)
        .values({
          schoolId: ctx.schoolId,
          name,
          academicYearId,
          startDate,
          endDate,
          isCurrent: isCurrent || false,
        })
        .returning();
    } catch {
      [newTerm] = await db
        .insert(terms)
        .values({
          name,
          academicYearId,
          startDate,
          endDate,
          isCurrent: isCurrent || false,
        } as any)
        .returning();
    }

    await logActivity({
      userId: ctx.userId,
      action: "create",
      entityType: "term",
      entityId: newTerm.id,
      description: `Created term ${name}`,
    });

    return successResponse(newTerm, 201);
  } catch (error) {
    console.error("Create term error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can update terms", 403);
    }

    const body = await request.json();
    const { id, name, academicYearId, startDate, endDate, isCurrent } = body;
    if (!id) return errorResponse("Term id is required", 400);

    let existing;
    try {
      [existing] = await db
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.id, id), eq(terms.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return errorResponse("Term not found", 404);
    }

    if (!existing) return errorResponse("Term not found", 404);

    if (academicYearId && !(await isAcademicYearInSchool(ctx.schoolId, academicYearId))) {
      return errorResponse("Academic year not found", 404);
    }

    if (isCurrent) {
      await db
        .update(terms)
        .set({ isCurrent: false })
        .where(eq(terms.schoolId, ctx.schoolId));
    }

    const [updated] = await db
      .update(terms)
      .set({
        name: name ?? undefined,
        academicYearId: academicYearId ?? undefined,
        startDate: startDate ?? undefined,
        endDate: endDate ?? undefined,
        isCurrent: isCurrent ?? undefined,
      })
      .where(and(eq(terms.id, id), eq(terms.schoolId, ctx.schoolId)))
      .returning();

    return successResponse(updated);
  } catch (error) {
    console.error("Update term error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    if (!hasSchoolAdminRole(ctx)) {
      return errorResponse("Only administrators can delete terms", 403);
    }

    const id = request.nextUrl.searchParams.get("id");
    if (!id) return errorResponse("Term id is required", 400);

    let existing;
    try {
      [existing] = await db
        .select({ id: terms.id })
        .from(terms)
        .where(and(eq(terms.id, id), eq(terms.schoolId, ctx.schoolId)))
        .limit(1);
    } catch {
      return errorResponse("Term not found", 404);
    }

    if (!existing) return errorResponse("Term not found", 404);

    await db
      .delete(terms)
      .where(and(eq(terms.id, id), eq(terms.schoolId, ctx.schoolId)));

    return successResponse({ message: "Term deleted" });
  } catch (error) {
    console.error("Delete term error:", error);
    return errorResponse("Internal server error", 500);
  }
}
