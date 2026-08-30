"use client";

import { useState } from "react";

interface ImageResult {
  id: string;
  thumbnailUrl: string;
  imageUrl: string;
  alt: string;
  creator: string | null;
  source: "Unsplash" | "Openverse";
  license: string | null;
}

interface ImageSearchResponse {
  success?: boolean;
  data?: { query: string; provider: string; images: ImageResult[] };
  error?: string;
}

interface QuestionImagePickerProps {
  questionText: string;
  subjectName?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export default function QuestionImagePicker({
  questionText,
  subjectName,
  value,
  onChange,
  disabled = false,
}: QuestionImagePickerProps) {
  const [images, setImages] = useState<ImageResult[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const suggestedQuery = [subjectName, questionText].filter(Boolean).join(" ").trim();

  async function searchImages() {
    const query = searchQuery.trim() || suggestedQuery;
    if (query.length < 2) {
      setError("Enter question text or a subject first.");
      setOpen(true);
      return;
    }

    setSearching(true);
    setError("");
    setOpen(true);
    const token = localStorage.getItem("el_token");
    try {
      const params = new URLSearchParams({ q: query });
      if (subjectName) params.set("subject", subjectName);
      const response = await fetch(`/api/images/search?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await response.json()) as ImageSearchResponse;
      if (!response.ok || !data.success || !data.data) {
        throw new Error(data.error || "No images found");
      }
      setImages(data.data.images);
      setProvider(data.data.provider);
    } catch (searchError) {
      console.error(searchError);
      setImages([]);
      setProvider("");
      setError(searchError instanceof Error ? searchError.message : "Image search is unavailable. You can leave this blank.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 mb-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs font-semibold text-slate-600">Question image <span className="font-normal text-slate-400">(optional)</span></p>
          <p className="text-[11px] text-slate-400 mt-0.5">Find a relevant stock image from the question and subject in one click.</p>
        </div>
        <button
          type="button"
          disabled={disabled || searching}
          onClick={() => void searchImages()}
          className="px-3 py-2 rounded-lg bg-secondary-100 text-secondary-700 text-xs font-semibold hover:bg-secondary-200 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {searching ? "Finding images..." : "✨ Find relevant images"}
        </button>
      </div>

      {value && (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-slate-50 border border-slate-100 p-2">
          <img src={value} alt="Selected question image" className="w-20 h-12 rounded-md object-cover bg-slate-200" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-green-700">Image selected</p>
            <p className="text-[11px] text-slate-400 truncate">{value}</p>
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange("")}
            className="px-2 py-1 rounded-md text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            Remove
          </button>
        </div>
      )}

      {open && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex gap-2 mb-3">
            <input
              type="search"
              value={searchQuery || suggestedQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void searchImages();
                }
              }}
              placeholder="Search by question topic or subject"
              className="min-w-0 flex-1 px-3 py-2 rounded-lg border border-slate-200 text-xs outline-none focus:ring-2 focus:ring-secondary-500"
              disabled={disabled || searching}
            />
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="px-2 py-2 rounded-lg text-[11px] text-slate-500 hover:bg-slate-100"
              title="Use the current question text again"
            >
              Reset
            </button>
          </div>

          {error && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-3">{error}</p>}
          {searching && <div className="py-5 text-center text-xs text-slate-500">Searching {subjectName ? `${subjectName} images` : "stock images"}...</div>}
          {!searching && images.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] text-slate-500">Choose an image to attach</p>
                <p className="text-[10px] text-slate-400">Results from {provider}</p>
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-56 overflow-y-auto">
                {images.map((image) => (
                  <button
                    type="button"
                    key={image.id}
                    disabled={disabled}
                    onClick={() => onChange(image.imageUrl)}
                    className={`group relative overflow-hidden rounded-lg border-2 aspect-[4/3] bg-slate-100 transition-all ${
                      value === image.imageUrl ? "border-secondary-500 ring-2 ring-secondary-200" : "border-transparent hover:border-secondary-300"
                    }`}
                    title={`${image.alt}${image.creator ? ` — ${image.creator}` : ""}`}
                  >
                    <img src={image.thumbnailUrl} alt={image.alt} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/60 text-white text-[9px] px-1.5 py-1 truncate text-left opacity-0 group-hover:opacity-100 transition-opacity">Use this image</span>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-2">
                {provider === "Unsplash" ? "Unsplash photos are shown with photographer attribution in the result title." : "Openverse images are openly licensed; review the listed license before publishing."} Select an image, or close this picker and leave the question without one.
              </p>
            </>
          )}
        </div>
      )}

      <details className="mt-2">
        <summary className="text-[11px] text-slate-400 cursor-pointer hover:text-slate-600">Advanced: paste an image URL</summary>
        <input
          type="url"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder="https://... (optional)"
          className="w-full mt-2 px-3 py-2 rounded-lg border border-slate-200 text-xs disabled:bg-slate-100"
        />
      </details>
    </div>
  );
}
