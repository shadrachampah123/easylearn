import { NextRequest } from "next/server";
import { db } from "@/db";
import { messages, users, notifications } from "@/db/schema";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { successResponse, errorResponse, unauthorizedResponse } from "@/lib/api-helpers";
import { eq, or, and, desc, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const otherUserId = request.nextUrl.searchParams.get("userId");

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
            and(eq(messages.senderId, payload.userId), eq(messages.receiverId, otherUserId)),
            and(eq(messages.senderId, otherUserId), eq(messages.receiverId, payload.userId))
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
          eq(messages.receiverId, payload.userId)
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
          or(eq(messages.senderId, payload.userId), eq(messages.receiverId, payload.userId))
        )
        .orderBy(desc(messages.createdAt))
        .limit(100);

      // Group by conversation partner
      const conversations = new Map();
      for (const msg of latestMessages) {
        const partnerId = msg.senderId === payload.userId ? msg.receiverId : msg.senderId;
        if (!conversations.has(partnerId)) {
          conversations.set(partnerId, {
            partnerId,
            partnerName: msg.senderId === payload.userId
              ? `${msg.receiverFirstName} ${msg.receiverLastName}`
              : `${msg.senderFirstName} ${msg.senderLastName}`,
            lastMessage: msg.content,
            lastMessageAt: msg.createdAt,
            isRead: msg.senderId === payload.userId || msg.isRead,
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
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();

    const body = await request.json();
    const { receiverId, content } = body;

    if (!receiverId || !content) {
      return errorResponse("Receiver and content are required");
    }

    // Verify receiver exists
    const [receiver] = await db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, receiverId))
      .limit(1);

    if (!receiver) {
      return errorResponse("Recipient not found", 404);
    }

    const [newMessage] = await db.insert(messages).values({
      senderId: payload.userId,
      receiverId,
      content,
    }).returning();

    // Create notification for receiver
    const [senderUser] = await db
      .select({ firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, payload.userId))
      .limit(1);

    await db.insert(notifications).values({
      userId: receiverId,
      type: "system",
      title: "New Message",
      message: `${senderUser.firstName} ${senderUser.lastName} sent you a message`,
      link: `/dashboard/messages?userId=${payload.userId}`,
    });

    return successResponse(newMessage, 201);
  } catch (error) {
    console.error("Send message error:", error);
    return errorResponse("Internal server error", 500);
  }
}
