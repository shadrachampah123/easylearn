/**
 * Server-side validation for attachment metadata.
 *
 * Clients upload files via POST /api/uploads and receive metadata objects
 * ({fileId, name, type, size, url}) that they attach to their assignment /
 * submission payloads. Those payloads must never be trusted as-is: this module
 * re-resolves every fileId against the `uploaded_files` table and confirms it
 * belongs to the acting user, was uploaded for the right purpose, and (for
 * learner submissions) is tied to the exact assignment being submitted.
 *
 * The returned metadata is rebuilt from the database row, so name/type/size
 * always come from the server, never from the client.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import {
  ensureFileUploadSchema,
  schemaAwareErrorMessage,
} from "@/lib/schema-resilience";
import {
  MAX_ATTACHMENTS,
  storedAttachments,
  type StoredAttachment,
} from "@/lib/uploads";

export interface ResolvedAttachments {
  attachments: StoredAttachment[] | null;
}

export interface AttachmentResolution {
  ok: boolean;
  error?: string;
  attachments: StoredAttachment[];
}

export async function resolveUploadedAttachments(
  attachments: unknown,
  options: {
    uploaderId: string;
    purpose: "assignment" | "submission";
    assignmentId?: string | null;
  }
): Promise<AttachmentResolution> {
  const input = storedAttachments(attachments);
  if (input.length === 0) return { ok: true, attachments: [] };

  if (input.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      error: `Too many files. You can attach at most ${MAX_ATTACHMENTS} files.`,
      attachments: [],
    };
  }

  // Make sure 0009 is applied (self-heals when AUTO_SCHEMA_REPAIR is on).
  await ensureFileUploadSchema();

  const fileIds = input.map((entry) => entry.fileId);
  const where = [
    inArray(uploadedFiles.id, fileIds),
    eq(uploadedFiles.uploaderId, options.uploaderId),
    eq(uploadedFiles.purpose, options.purpose),
  ];
  if (options.purpose === "submission") {
    if (!options.assignmentId) {
      return {
        ok: false,
        error: "Submission files must be uploaded against the assignment being submitted.",
        attachments: [],
      };
    }
    where.push(eq(uploadedFiles.assignmentId, options.assignmentId));
  }

  try {
    const rows = await db
      .select()
      .from(uploadedFiles)
      .where(and(...where));

    const byId = new Map(rows.map((row) => [row.id, row]));

    // Every fileId must resolve to one of the uploader's own rows. Missing or
    // foreign ids mean the payload was tampered with (or the file was removed).
    const missing = input.filter((entry) => !byId.has(entry.fileId));
    if (missing.length > 0) {
      return {
        ok: false,
        error: `One or more attached files are no longer available (${missing
          .map((entry) => entry.name)
          .join(", ")}). Please re-upload and try again.`,
        attachments: [],
      };
    }

    const resolved = input.map((entry) => {
      const row = byId.get(entry.fileId)!;
      return {
        fileId: row.id,
        name: row.originalName,
        type: row.category,
        size: row.sizeBytes,
        url: `/api/files/${row.id}`,
      } satisfies StoredAttachment;
    });

    return { ok: true, attachments: resolved };
  } catch (error) {
    return {
      ok: false,
      error: schemaAwareErrorMessage(
        error,
        "The attached files could not be verified. Please try again."
      ),
      attachments: [],
    };
  }
}
