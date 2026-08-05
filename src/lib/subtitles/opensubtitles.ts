/**
 * OpenSubtitles REST API client, served through the primary melana-rs proxy.
 *
 * The proxy owns the upstream API key and rewrites temporary download links
 * through its CORS-safe `/opensubtitles/file` endpoint. Nothing related to an
 * OpenSubtitles credential is exposed to the browser.
 */

import { proxyOrigin } from "$lib/streaming/client";

const API_BASE = `${proxyOrigin}/opensubtitles`;
const SUBTITLE_FILE_ENDPOINT = `${API_BASE}/file`;
const MAX_ERROR_DETAIL_LENGTH = 240;

const JSON_HEADERS = {
  Accept: "application/json",
};

const JSON_REQUEST_HEADERS = {
  ...JSON_HEADERS,
  "Content-Type": "application/json",
};

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

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function stableId(value: unknown): string | null {
  const text = nonEmptyString(value);
  if (text) return text;
  return typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
}

function sanitizeErrorDetail(value: unknown): string | null {
  const detail = nonEmptyString(value);
  // Do not surface a proxy/upstream HTML response in the player UI.
  if (!detail || /<[^>]+>/.test(detail)) return null;
  return detail.slice(0, MAX_ERROR_DETAIL_LENGTH);
}

async function responseError(
  operation: string,
  response: Response,
): Promise<Error> {
  let detail: string | null = null;

  if (response.status >= 300 && response.status < 400) {
    detail = "The subtitle proxy returned a redirect instead of the expected response.";
  } else if (response.headers.get("content-type")?.toLowerCase().includes("json")) {
    const payload: unknown = await response.json().catch(() => null);
    if (isJsonObject(payload)) {
      detail =
        sanitizeErrorDetail(payload.message) ??
        sanitizeErrorDetail(payload.error);
    }
  }

  const message = `OpenSubtitles ${operation} failed (${response.status})`;
  return new Error(detail ? `${message}: ${detail}` : message);
}

async function readJsonObject(
  response: Response,
  operation: string,
): Promise<JsonObject> {
  try {
    const payload: unknown = await response.json();
    if (!isJsonObject(payload)) throw new Error("Expected a JSON object.");
    return payload;
  } catch {
    throw new Error(`OpenSubtitles ${operation} returned an invalid JSON response.`);
  }
}

/**
 * Keep subtitle file traffic on the configured primary proxy. The backend may
 * return either an absolute link or the documented relative `/opensubtitles/file`
 * link; both resolve to the same CORS-safe endpoint.
 */
function normalizeProxySubtitleFileUrl(link: unknown): string {
  const value = nonEmptyString(link);
  if (!value) {
    throw new Error("OpenSubtitles download did not return a subtitle file link.");
  }

  let fileUrl: URL;
  let expectedEndpoint: URL;
  try {
    fileUrl = new URL(value, `${proxyOrigin}/`);
    expectedEndpoint = new URL(SUBTITLE_FILE_ENDPOINT);
  } catch {
    throw new Error("OpenSubtitles download returned an invalid subtitle file link.");
  }

  if (
    fileUrl.origin !== expectedEndpoint.origin ||
    fileUrl.pathname !== expectedEndpoint.pathname ||
    !fileUrl.searchParams.get("url")
  ) {
    throw new Error(
      "OpenSubtitles download returned a subtitle file link outside the configured proxy.",
    );
  }

  return fileUrl.href;
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
  assertPositiveSafeInteger(tmdbId, "TMDB ID");
  const requestedLanguage = nonEmptyString(language);
  if (!requestedLanguage) {
    throw new TypeError("Subtitle language must be a non-empty string.");
  }

  const params = new URLSearchParams({
    tmdb_id: String(tmdbId),
    languages: requestedLanguage,
    order_by: "download_count",
  });

  if (mediaType === "tv") {
    if (season != null) params.set("season_number", String(season));
    if (episode != null) params.set("episode_number", String(episode));
  }

  const response = await fetch(`${API_BASE}/subtitles?${params}`, {
    headers: JSON_HEADERS,
    signal,
  });

  if (!response.ok) {
    throw await responseError("search", response);
  }

  const payload = await readJsonObject(response, "search");
  const rawSubtitles = Array.isArray(payload.data) ? payload.data : [];
  const results: OpenSubtitlesResult[] = [];

  for (const raw of rawSubtitles) {
    if (!isJsonObject(raw) || !isJsonObject(raw.attributes)) continue;
    const attributes = raw.attributes;
    const rawFiles = Array.isArray(attributes.files) ? attributes.files : [];
    const files: OpenSubtitlesFile[] = [];

    for (const rawFile of rawFiles) {
      if (!isJsonObject(rawFile)) continue;
      const id = rawFile.file_id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) continue;

      files.push({
        id,
        fileName: nonEmptyString(rawFile.file_name) ?? "Unknown",
        downloads: nonNegativeNumber(rawFile.downloads) ?? 0,
        language: nonEmptyString(attributes.language) ?? requestedLanguage,
      });
    }

    if (files.length === 0) continue;

    const id = stableId(attributes.subtitle_id) ?? stableId(raw.id);
    // A stable id is required to keep the result selector and subtitle tracks
    // deterministic across reactive updates.
    if (!id) continue;

    results.push({
      id,
      release: nonEmptyString(attributes.release) ?? files[0].fileName,
      downloads:
        nonNegativeNumber(attributes.download_count) ??
        files.reduce((sum, file) => sum + file.downloads, 0),
      files,
      language: nonEmptyString(attributes.language) ?? requestedLanguage,
    });
  }

  // Sort by total downloads descending.
  results.sort((a, b) => b.downloads - a.downloads);
  return results;
}

/**
 * Request a temporary, proxy-wrapped download link for a subtitle file.
 */
export async function downloadSubtitle(
  fileId: number,
  signal?: AbortSignal,
): Promise<string> {
  assertPositiveSafeInteger(fileId, "Subtitle file ID");

  const response = await fetch(`${API_BASE}/download`, {
    method: "POST",
    headers: JSON_REQUEST_HEADERS,
    body: JSON.stringify({ file_id: fileId }),
    signal,
  });

  if (!response.ok) {
    throw await responseError("download", response);
  }

  const payload = await readJsonObject(response, "download");
  return normalizeProxySubtitleFileUrl(payload.link);
}

/**
 * Fetch a subtitle file through the proxy and return its text content.
 */
export async function fetchSubtitleText(
  fileId: number,
  signal?: AbortSignal,
): Promise<string> {
  const link = await downloadSubtitle(fileId, signal);
  const response = await fetch(link, { signal });
  if (!response.ok) {
    throw await responseError("file download", response);
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
