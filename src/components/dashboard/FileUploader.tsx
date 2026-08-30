"use client";

import { useEffect, useRef, useState } from "react";
import {
  CATEGORY_ICONS,
  MAX_ATTACHMENTS,
  MAX_VIDEO_SIZE_BYTES,
  MAX_FILE_SIZE_BYTES,
  UPLOAD_ACCEPT,
  categoryForFile,
  formatBytes,
  type StoredAttachment,
} from "@/lib/uploads";

export type { StoredAttachment };

interface FileUploaderProps {
  /** "assignment" for teacher materials, "submission" for learner work. */
  purpose: "assignment" | "submission";
  /** Required when purpose is "submission". */
  assignmentId?: string;
  /** Currently attached files (metadata returned by POST /api/uploads). */
  value: StoredAttachment[];
  onChange: (attachments: StoredAttachment[]) => void;
  /** Disables adding new files (existing files stay visible). */
  disabled?: boolean;
  maxFiles?: number;
  /** Notifies the parent while files are being uploaded (guard the submit button). */
  onUploadingChange?: (uploading: boolean) => void;
}

interface UploadTask {
  fileName: string;
  progress: number;
}

type UploadMode = "local" | "object";

interface PresignedUpload {
  fileId: string;
  attachment: StoredAttachment;
  upload: {
    method: string;
    url: string;
    headers: Record<string, string>;
    expiresInSeconds: number;
  };
}

/**
 * Local-device file uploader used by the assignment creation form (teacher)
 * and the assignment submission form (learner).
 *
 * Client-side validation mirrors the server rules (type allow-list, strict
 * 100 MB video limit, 50 MB for other files) so users get instant feedback.
 *
 * The upload backend is detected once on mount: when cloud object storage
 * (S3 / Cloudflare R2 / MinIO) is configured, files are PUT straight to the
 * bucket via a presigned URL — bypassing the serverless request-body limit so
 * 100 MB videos upload reliably. Otherwise a multipart POST to /api/uploads
 * stores the bytes on local disk (the original behaviour).
 */
export default function FileUploader({
  purpose,
  assignmentId,
  value,
  onChange,
  disabled = false,
  maxFiles = MAX_ATTACHMENTS,
  onUploadingChange,
}: FileUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<UploadMode>("local");

  const uploading = tasks.length > 0;

  useEffect(() => {
    onUploadingChange?.(uploading);
  }, [uploading, onUploadingChange]);

  // Detect the upload backend once. On any failure we keep "local" (multipart)
  // so uploads still work on a plain disk-backed deployment.
  useEffect(() => {
    const token = localStorage.getItem("el_token");
    fetch("/api/uploads", { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.json())
      .then((data: { success?: boolean; data?: { storage?: UploadMode } }) => {
        if (data?.success && data?.data?.storage === "object") setMode("object");
      })
      .catch(() => {
        /* stay on "local" */
      });
  }, []);

  function validateFile(file: File): string | null {
    const category = categoryForFile(file.name, file.type || undefined);
    if (!category) {
      return `"${file.name}" is not a supported file type. Allowed: documents (PDF, Word, PowerPoint, Excel, text), images, audio, video and ZIP.`;
    }
    if (file.size === 0) {
      return `"${file.name}" is empty and cannot be uploaded.`;
    }
    if (category === "video" && file.size > MAX_VIDEO_SIZE_BYTES) {
      return `"${file.name}" is ${formatBytes(file.size)} — over the strict 100 MB limit for video uploads.`;
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return `"${file.name}" is ${formatBytes(file.size)} — over the 50 MB limit for this file type.`;
    }
    return null;
  }

  function trackProgress(fileName: string) {
    return (event: ProgressEvent) => {
      if (event.lengthComputable) {
        const progress = Math.round((event.loaded / event.total) * 100);
        setTasks((prev) =>
          prev.map((task) => (task.fileName === fileName ? { ...task, progress } : task))
        );
      }
    };
  }

  function uploadOne(file: File): Promise<StoredAttachment> {
    return mode === "object" ? uploadOneDirect(file) : uploadOneMultipart(file);
  }

  /* ── Direct to cloud object storage via presigned PUT ── */
  function uploadOneDirect(file: File): Promise<StoredAttachment> {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem("el_token");

      fetch("/api/uploads/presign", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          purpose,
          assignmentId: assignmentId || undefined,
          name: file.name,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
        }),
      })
        .then((response) => response.json().then((data) => ({ response, data })))
        .then(({ response, data }) => {
          if (!(response.ok && data?.success)) {
            throw new Error(data?.error || "The upload could not be prepared. Please try again.");
          }
          const presigned = data.data as PresignedUpload;
          return putFile(presigned.attachment, presigned.upload, file);
        })
        .then(resolve)
        .catch((uploadError) =>
          reject(uploadError instanceof Error ? uploadError : new Error(String(uploadError)))
        );
    });
  }

  function putFile(
    attachment: StoredAttachment,
    upload: PresignedUpload["upload"],
    file: File
  ): Promise<StoredAttachment> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method || "PUT", upload.url);
      for (const [header, value] of Object.entries(upload.headers || {})) {
        xhr.setRequestHeader(header, value);
      }
      xhr.upload.onprogress = trackProgress(file.name);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(attachment);
        } else {
          reject(
            new Error(
              `The upload to cloud storage failed (HTTP ${xhr.status}). Please try again.`
            )
          );
        }
      };
      xhr.onerror = () => reject(new Error("Network error — the upload could not be completed."));
      xhr.send(file);
    });
  }

  /* ── Legacy multipart upload to local disk ── */
  function uploadOneMultipart(file: File): Promise<StoredAttachment> {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem("el_token");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/uploads");
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);

      const form = new FormData();
      form.append("purpose", purpose);
      if (assignmentId) form.append("assignmentId", assignmentId);
      form.append("file", file);

      xhr.upload.onprogress = trackProgress(file.name);
      xhr.onload = () => {
        let data: { success?: boolean; data?: StoredAttachment[]; error?: string } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* response was not JSON — handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.success && Array.isArray(data.data)) {
          resolve(data.data[0]);
        } else {
          reject(new Error(data.error || "The upload failed. Please try again."));
        }
      };
      xhr.onerror = () => reject(new Error("Network error — the upload could not be completed."));
      xhr.send(form);
    });
  }

  async function handleFiles(files: File[]) {
    if (disabled || uploading) return;
    setError(null);

    const errors: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (value.length + accepted.length >= maxFiles) {
        errors.push(`You can attach at most ${maxFiles} files.`);
        break;
      }
      const problem = validateFile(file);
      if (problem) {
        errors.push(problem);
      } else {
        accepted.push(file);
      }
    }
    if (errors.length > 0) setError(errors.join("\n"));

    // Accumulate locally: `value` is captured once at call time, so using it
    // inside the loop after awaits would drop files uploaded earlier.
    let accumulated = value;
    for (const file of accepted) {
      setTasks((prev) => [...prev, { fileName: file.name, progress: 0 }]);
      try {
        const attachment = await uploadOne(file);
        accumulated = [...accumulated, attachment];
        onChange(accumulated);
      } catch (uploadError) {
        setError((prev) =>
          [prev, uploadError instanceof Error ? uploadError.message : String(uploadError)]
            .filter(Boolean)
            .join("\n")
        );
      } finally {
        setTasks((prev) => prev.filter((task) => task.fileName !== file.name));
      }
    }

    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleRemove(attachment: StoredAttachment) {
    const next = value.filter((entry) => entry.fileId !== attachment.fileId);
    onChange(next);

    // Best-effort server-side cleanup so the file does not linger on disk
    // (or in the object-storage bucket when that backend is enabled).
    const token = localStorage.getItem("el_token");
    try {
      await fetch(`/api/uploads/${attachment.fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      /* ignore cleanup failures */
    }
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload files from your device"
        onClick={() => !disabled && !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if (!disabled && !uploading && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          if (!disabled && !uploading) setDragging(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={(e) => {
          e.preventDefault();
          dragDepth.current -= 1;
          if (dragDepth.current <= 0) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (!disabled && !uploading && e.dataTransfer.files.length > 0) {
            handleFiles(Array.from(e.dataTransfer.files));
          }
        }}
        className={`rounded-2xl border-2 border-dashed p-5 text-center transition-colors ${
          disabled
            ? "border-slate-200 bg-slate-50 cursor-not-allowed"
            : dragging
              ? "border-accent-400 bg-accent-50 cursor-pointer"
              : "border-slate-300 bg-slate-50/60 hover:border-accent-300 hover:bg-accent-50/40 cursor-pointer"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="hidden"
          disabled={disabled || uploading}
          onChange={(e) => {
            if (e.target.files?.length) handleFiles(Array.from(e.target.files));
          }}
        />
        <div className="text-3xl mb-1">{uploading ? "⏳" : "📤"}</div>
        <p className="text-sm font-semibold text-slate-700">
          {uploading
            ? "Uploading…"
            : disabled
              ? "File uploads are disabled"
              : "Click or drop files here to upload from your device"}
        </p>
        <p className="text-xs text-slate-500 mt-1">
          Documents · PDFs · Images · Audio · Video · ZIP &nbsp;|&nbsp; Videos: max 100 MB · other files: max 50 MB
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-sm whitespace-pre-line">
          ⚠️ {error}
        </div>
      )}

      {tasks.map((task) => (
        <div key={task.fileName} className="p-3 rounded-xl bg-white border border-slate-200">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="font-medium text-slate-700 truncate">📄 {task.fileName}</span>
            <span className="text-xs font-semibold text-accent-600 shrink-0">{task.progress}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden mt-2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent-500 to-accent-600 transition-all"
              style={{ width: `${task.progress}%` }}
            />
          </div>
        </div>
      ))}

      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((attachment) => (
            <div
              key={attachment.fileId}
              className="flex items-center gap-3 p-3 rounded-xl bg-white border border-slate-200"
            >
              <div className="w-10 h-10 rounded-xl bg-slate-100 flex items-center justify-center text-xl shrink-0">
                {CATEGORY_ICONS[attachment.type as keyof typeof CATEGORY_ICONS] || "📎"}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 truncate">{attachment.name}</p>
                <p className="text-xs text-slate-400">
                  {attachment.type} · {formatBytes(attachment.size)}
                </p>
              </div>
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(attachment)}
                  disabled={uploading}
                  className="text-slate-400 hover:text-rose-500 text-sm px-2 py-1 rounded-lg hover:bg-rose-50 transition-colors disabled:opacity-40"
                  title="Remove file"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
