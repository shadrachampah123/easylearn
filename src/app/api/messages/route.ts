import { NextRequest } from "next/server";
import { db } from "@/db";
import { messages, users, notifications } from "@/db/schema";
import { successResponse, errorResponse } from "@/lib/api-helpers";
import { eq, or, and, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { guardSchoolContext, isUserInSchool, sqlUserInSchool } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const otherUserId = request.nextUrl.searchParams.get("userId");

    /* Phase 2C: a conversation may only be opened with a member of the caller's own school.
       Another school's user is reported as missing rather than forbidden, so the endpoint
       cannot be used to probe who exists elsewhere. */
    if (otherUserId && !(await isUserInSchool(ctx.schoolId, otherUserId))) {
      return errorResponse("User not found", 404);
    }

    const sender = alias(users, "sender");
    const receiver = alias(users, "receiver");

    let results;

    if (otherUserId) {
      // Get conversation with specific user
      results = await db
        .select({
          id: messages.id,
          content: messages.content,
          isRead: messages.isRead,
          createdAt: messages.createdAt,
          senderId: messages.senderId,
          receiverId: messages.receiverId,
          senderFirstName: sender.firstName,
          senderLastName: sender.lastName,
          receiverFirstName: receiver.firstName,
          receiverLastName: receiver.lastName,
        })
        .from(messages)
        .leftJoin(sender, eq(messages.senderId, sender.id))
        .leftJoin(receiver, eq(messages.receiverId, receiver.id))
        .where(
          or(
            and(eq(messages.senderId, ctx.userId), eq(messages.receiverId, otherUserId)),
            and(eq(messages.senderId, otherUserId), eq(messages.receiverId, ctx.userId))
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(100);

      // Mark messages as read
      await db
        .update(messages)
        .set({ isRead: true })
        .where(and(
          eq(messages.senderId, otherUserId),
          eq(messages.receiverId, ctx.userId)
        ));
    } else {
      // Get list of conversations (latest message per user)
      const latestMessages = await db
        .select({
          id: messages.id,
          content: messages.content,
          isRead: messages.isRead,
          createdAt: messages.createdAt,
          senderId: messages.senderId,
          receiverId: messages.receiverId,
          senderFirstName: sender.firstName,
          senderLastName: sender.lastName,
          receiverFirstName: receiver.firstName,
          receiverLastName: receiver.lastName,
        })
        .from(messages)
        .leftJoin(sender, eq(messages.senderId, sender.id))
        .leftJoin(receiver, eq(messages.receiverId, receiver.id))
        .where(
          or(eq(messages.senderId, ctx.userId), eq(messages.receiverId, ctx.userId))
        )
        .orderBy(desc(messages.createdAt))
        .limit(100);

      // Group by conversation partner
      const conversations = new Map();
      for (const msg of latestMessages) {
        const partnerId = msg.senderId === ctx.userId ? msg.receiverId : msg.senderId;
        if (!conversations.has(partnerId)) {
          conversations.set(partnerId, {
            partnerId,
            partnerName: msg.senderId === ctx.userId
              ? `${msg.receiverFirstName} ${msg.receiverLastName}`
              : `${msg.senderFirstName} ${msg.senderLastName}`,
            lastMessage: msg.content,
            lastMessageAt: msg.createdAt,
            isRead: msg.senderId === ctx.userId || msg.isRead,
          });
        }
      }

      results = Array.from(conversations.values());
    }

    return successResponse(results);
  } catch (error) {
    console.error("Messages error:", error);
    return errorResponse("Internal server error", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await guardSchoolContext(request);
    if (!auth.ok) return auth.response;
    const ctx = auth.context;

    const body = await request.json();
    const { receiverId, content } = body;

    if (!receiverId || !content) {
      return errorResponse("Receiver and content are required");
    }

    /* Phase 2C: sender and receiver must share a school. The recipient query is scoped by
       the membership predicate, so a message can never be delivered across the boundary. */
    const [receiver] = await db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(and(
        eq(users.id, receiverId),
        sqlUserInSchool(ctx.schoolId, users.id)
      ))
      .limit(1);

    if (!receiver) {
      return errorResponse("Recipient not found", 404);
    }

    let newMessage;
    try {
      [newMessage] = await db.insert(messages).values({
        schoolId: ctx.schoolId,
        senderId: ctx.userId,
        receiverId,
        content,
      }).returning();
    } catch {
      [newMessage] = await db.insert(messages).values({
        senderId: ctx.userId,
        receiverId,
        content,
      } as any).returning();
    }

    // Create notification for receiver
    const [senderUser] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1);

    try {
      await db.insert(notifications).values({
        schoolId: ctx.schoolId,
        userId: receiverId,
        type: "system",
        title: "New Message",
        message: `${senderUser.firstName} ${senderUser.lastName} sent you a message`,
        link: `/dashboard/messages?userId=${ctx.userId}`,
      });
    } catch {
      await db.insert(notifications).values({
        userId: receiverId,
        type: "system",
        title: "New Message",
        message: `${senderUser.firstName} ${senderUser.lastName} sent you a message`,
        link: `/dashboard/messages?userId=${ctx.userId}`,
      } as any);
    }

    return successResponse(newMessage, 201);
  } catch (error) {
    console.error("Send message error:", error);
    return errorResponse("Internal server error", 500);
  }
}
