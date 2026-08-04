/**
 * OpenSubtitles REST API v1 client.
 *
 * Requires a free API key from <https://www.opensubtitles.com/en/consumers>.
 * Set it as `PUBLIC_OPENSUBTITLES_API_KEY` in your environment.
 *
 * Free-tier limits: 20 downloads/day, 1 search/second. The client is
 * deliberately minimal — no caching, no retry, no auth tokens.
 */

import { env } from "$env/dynamic/public";

const API_BASE = "https://api.opensubtitles.com/api/v1";

const API_KEY = (env as any).PUBLIC_OPENSUBTITLES_API_KEY ?? "";

export function isOpenSubtitlesConfigured(): boolean {
  return API_KEY.length > 0;
}

export interface OpenSubtitlesFile {
  id: number;
  fileName: string;
  downloads: number;
  /** BCP-47-ish language code from the API (e.g. "en"). */
  language: string;
}

export interface OpenSubtitlesResult {
  id: string;
  /** Release / group name shown in the UI. */
  release: string;
  downloads: number;
  files: OpenSubtitlesFile[];
  /** Human-readable language name. */
  language: string;
}

interface RawFileAttribute {
  file_id?: number;
  file_name?: string;
  downloads?: number;
  sub_format?: string;
}

interface RawSubtitle {
  id?: string;
  type?: string;
  attributes?: {
    subtitle_id?: string;
    release?: string;
    download_count?: number;
    language?: string;
    files?: RawFileAttribute[];
  };
}

function headers(): Record<string, string> {
  return {
    "Api-Key": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Melana v0.1",
  };
}

/**
 * Search OpenSubtitles by TMDB id. For TV shows, pass season and episode
 * numbers to narrow results to a specific episode.
 */
export async function searchSubtitles(
  tmdbId: number,
  language: string,
  mediaType: "movie" | "tv",
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<OpenSubtitlesResult[]> {
  if (!API_KEY) {
    throw new Error("OpenSubtitles API key is not configured.");
  }

  const params = new URLSearchParams({
    tmdb_id: String(tmdbId),
    languages: language,
    order_by: "download_count",
  });

  if (mediaType === "tv") {
    if (season != null) params.set("season_number", String(season));
    if (episode != null) params.set("episode_number", String(episode));
  }

  const response = await fetch(`${API_BASE}/subtitles?${params}`, {
    headers: headers(),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenSubtitles search failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const payload = (await response.json()) as {
    data?: RawSubtitle[];
    total_pages?: number;
    total_count?: number;
  };

  const results: OpenSubtitlesResult[] = [];
  for (const raw of payload.data ?? []) {
    const attrs = raw.attributes;
    if (!attrs || !attrs.files || attrs.files.length === 0) continue;

    const files: OpenSubtitlesFile[] = attrs.files
      .filter((f): f is Required<Pick<RawFileAttribute, "file_id">> & RawFileAttribute =>
        typeof f.file_id === "number",
      )
      .map((f) => ({
        id: f.file_id,
        fileName: typeof f.file_name === "string" ? f.file_name : "Unknown",
        downloads: typeof f.downloads === "number" ? f.downloads : 0,
        language: typeof attrs.language === "string" ? attrs.language : language,
      }));

    if (files.length === 0) continue;

    results.push({
      id: attrs.subtitle_id ?? raw.id ?? String(Math.random()),
      release: typeof attrs.release === "string" ? attrs.release : files[0].fileName,
      downloads:
        typeof attrs.download_count === "number"
          ? attrs.download_count
          : files.reduce((sum, f) => sum + f.downloads, 0),
      files,
      language: typeof attrs.language === "string" ? attrs.language : language,
    });
  }

  // Sort by total downloads descending
  results.sort((a, b) => b.downloads - a.downloads);
  return results;
}

/**
 * Request a temporary download link for a subtitle file. The returned URL
 * is valid for a short window (typically a few minutes).
 */
export async function downloadSubtitle(
  fileId: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!API_KEY) {
    throw new Error("OpenSubtitles API key is not configured.");
  }

  const response = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ file_id: fileId }),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OpenSubtitles download failed (${response.status})${text ? `: ${text}` : ""}`,
    );
  }

  const payload = (await response.json()) as { link?: string };
  if (typeof payload.link !== "string" || !payload.link) {
    throw new Error("OpenSubtitles did not return a download link.");
  }

  return payload.link;
}

/**
 * Fetch a subtitle file from OpenSubtitles and return its text content.
 */
export async function fetchSubtitleText(
  fileId: number,
  signal?: AbortSignal,
): Promise<string> {
  const link = await downloadSubtitle(fileId, signal);
  const response = await fetch(link, { signal });
  if (!response.ok) {
    throw new Error(`Failed to fetch subtitle file (${response.status}).`);
  }
  return response.text();
}

/** Common subtitle languages for the picker UI. */
export const SUBTITLE_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "ar", label: "Arabic" },
  { code: "hi", label: "Hindi" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "ru", label: "Russian" },
  { code: "pl", label: "Polish" },
  { code: "tr", label: "Turkish" },
  { code: "ml", label: "Malayalam" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
] as const;
