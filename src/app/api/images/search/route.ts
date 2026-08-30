import { NextRequest } from "next/server";
import { getTokenFromRequest, verifyToken } from "@/lib/auth";
import { errorResponse, successResponse, unauthorizedResponse } from "@/lib/api-helpers";

const STAFF_ROLES = ["super_admin", "school_admin", "head_teacher", "teacher"];

interface ImageResult {
  id: string;
  thumbnailUrl: string;
  imageUrl: string;
  alt: string;
  creator: string | null;
  source: "Unsplash" | "Openverse";
  license: string | null;
}

interface UnsplashResponse {
  results?: Array<{
    id: string;
    alt_description?: string | null;
    description?: string | null;
    urls?: { small?: string; regular?: string };
    user?: { name?: string };
  }>;
}

interface OpenverseResponse {
  results?: Array<{
    id?: string;
    thumbnail?: string;
    url?: string;
    title?: string | null;
    creator?: string | null;
    license?: string | null;
  }>;
}

function makeQuery(request: NextRequest) {
  const text = request.nextUrl.searchParams.get("q")?.trim() || "";
  const subject = request.nextUrl.searchParams.get("subject")?.trim() || "";
  return [subject, text].filter(Boolean).join(" ").slice(0, 160);
}

async function searchUnsplash(query: string, accessKey: string): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    query,
    per_page: "12",
    content_filter: "high",
    client_id: accessKey,
  });
  const response = await fetch(`https://api.unsplash.com/search/photos?${params.toString()}`, {
    headers: { Accept: "application/json", "Accept-Version": "v1" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];

  const data = (await response.json()) as UnsplashResponse;
  return (data.results || [])
    .map((image) => ({
      id: `unsplash-${image.id}`,
      thumbnailUrl: image.urls?.small || "",
      imageUrl: image.urls?.regular || image.urls?.small || "",
      alt: image.alt_description || image.description || query,
      creator: image.user?.name || null,
      source: "Unsplash" as const,
      license: "Unsplash License",
    }))
    .filter((image) => image.thumbnailUrl && image.imageUrl);
}

async function searchOpenverse(query: string): Promise<ImageResult[]> {
  const params = new URLSearchParams({ q: query, page_size: "12" });
  const response = await fetch(`https://api.openverse.org/v1/images/?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];

  const data = (await response.json()) as OpenverseResponse;
  return (data.results || [])
    .map((image, index) => ({
      id: `openverse-${image.id || index}`,
      thumbnailUrl: image.thumbnail || image.url || "",
      imageUrl: image.url || image.thumbnail || "",
      alt: image.title || query,
      creator: image.creator || null,
      source: "Openverse" as const,
      license: image.license || "Open license",
    }))
    .filter((image) => image.thumbnailUrl && image.imageUrl);
}

export async function GET(request: NextRequest) {
  try {
    const token = getTokenFromRequest(request);
    if (!token) return unauthorizedResponse();
    const payload = await verifyToken(token);
    if (!payload) return unauthorizedResponse();
    if (!STAFF_ROLES.includes(payload.role)) return errorResponse("Only staff can search for quiz images", 403);

    const query = makeQuery(request);
    if (query.length < 2) {
      return errorResponse("Add some question text or a subject before searching for an image");
    }

    let images: ImageResult[] = [];
    let provider: ImageResult["source"] = "Openverse";
    const unsplashKey = process.env.UNSPLASH_ACCESS_KEY?.trim();

    if (unsplashKey) {
      try {
        images = await searchUnsplash(query, unsplashKey);
        if (images.length > 0) provider = "Unsplash";
      } catch (error) {
        console.warn("Unsplash image search unavailable; trying Openverse", error);
      }
    }

    // Openverse is the no-key fallback, so the image picker works immediately in local,
    // preview, and production environments without making teachers paste URLs.
    if (images.length === 0) {
      try {
        images = await searchOpenverse(query);
        provider = "Openverse";
      } catch (error) {
        console.warn("Openverse image search unavailable", error);
      }
    }

    if (images.length === 0) {
      return errorResponse("No relevant stock images were found. You can try another keyword or leave the image blank.", 502);
    }

    return successResponse({ query, provider, images });
  } catch (error) {
    console.error("Image search error:", error);
    return errorResponse("Image search is temporarily unavailable. You can leave this question without an image.", 503);
  }
}
