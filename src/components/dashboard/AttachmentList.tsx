"use client";

import {
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  formatBytes,
  storedAttachments,
  type StoredAttachment,
} from "@/lib/uploads";

/**
 * Renders stored attachment metadata as a friendly list:
 *  - images / videos / audio preview inline
 *  - everything else as a download link
 * File URLs are /api/files/<id> which require a token, so links carry
 * ?token= (the <video>/<a> elements cannot set an Authorization header).
 */
export default function AttachmentList({
  attachments,
  compact = false,
}: {
  attachments: unknown;
  compact?: boolean;
}) {
  const items = storedAttachments(attachments);
  if (items.length === 0) return null;

  const token = typeof window !== "undefined" ? localStorage.getItem("el_token") || "" : "";

  function fileUrl(attachment: StoredAttachment): string {
    return `${attachment.url}?token=${encodeURIComponent(token)}`;
  }

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {items.map((attachment) => {
        const category = attachment.type;
        const icon = CATEGORY_ICONS[category as keyof typeof CATEGORY_ICONS] || "📎";
        const label = CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] || category;

        return (
          <div key={attachment.fileId}>
            {category === "image" && (
              <div className="rounded-xl overflow-hidden border border-slate-200 bg-slate-50">
                <img
                  src={fileUrl(attachment)}
                  alt={attachment.name}
                  className="w-full max-h-72 object-contain"
                  loading="lazy"
                />
              </div>
            )}
            {category === "video" && (
              <div className="rounded-xl overflow-hidden border border-slate-200 bg-black/95">
                <video
                  src={fileUrl(attachment)}
                  controls
                  preload="metadata"
                  className="w-full max-h-80"
                >
                  Your browser does not support video playback.
                </video>
              </div>
            )}
            {category === "audio" && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                <audio src={fileUrl(attachment)} controls preload="metadata" className="w-full">
                  Your browser does not support audio playback.
                </audio>
              </div>
            )}

            <a
              href={fileUrl(attachment)}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-200 hover:border-accent-300 hover:bg-accent-50/40 transition-colors ${
                (category === "image" || category === "video" || category === "audio") && !compact
                  ? "mt-2"
                  : ""
              }`}
            >
              <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-xl shrink-0">
                {icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-700 truncate">{attachment.name}</p>
                <p className="text-xs text-slate-400">
                  {label} · {formatBytes(attachment.size)} · tap to open/download
                </p>
              </div>
              <span className="text-accent-600 text-sm font-semibold shrink-0">⬇</span>
            </a>
          </div>
        );
      })}
    </div>
  );
}
