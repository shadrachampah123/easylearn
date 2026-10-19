import { NextRequest } from "next/server";
import { db } from "@/db";
import { messages } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, and } from "drizzle-orm";
import { guardSchoolContext } from "@/lib/tenant";

/**
 * Marks a conversation as read.
 *
 * This is a `POST` because it writes. It used to be a side effect of
 * `GET /api/messages?userId=...`, which meant that simply loading a conversation
 * — including from a prefetch or a cross-site request — changed a row in the
 * database.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse("Invalid request body", 400);
    }

    const otherUserId = (body as Record<string, unknown>).userId;
    if (typeof otherUserId !== "string" || !otherUserId) {
      return errorResponse("A userId is required", 400);
    }

    /* The recipient predicate is scoped to the caller's school, so a message can
       never be marked as read across the tenant boundary. */
    const updated = await db
      .update(messages)
      .set({ isRead: true })
      .where(and(
        eq(messages.schoolId, ctx.schoolId),
        eq(messages.senderId, otherUserId),
        eq(messages.receiverId, ctx.userId)
      ))
      .returning({ id: messages.id });

    return successResponse({ updated: updated.length });
  } catch (error) {
    console.error("Mark messages read error:", error);
    return errorResponse("Internal server error", 500);
  }
}
