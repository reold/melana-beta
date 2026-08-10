import type { MediaType } from "$lib/tmdb/types";

/**
 * Stream sources are now fetched via the unified `/sources` endpoint which
 * aggregates multiple providers (vidfast, vidlink, etc). Each stream item
 * contains a direct media URL, its origin header requirement, the container
 * type and any subtitle tracks.
 *
 * Playback still goes through the proxy layer:
 *  - `melana-rs` (proxyOrigin) for HLS manifests (WAF bypass + manifest
 *    rewriting via `proxy=<fastOrigin>`).
 *  - `spadik` (fastProxyOrigin) for segments, mp4 files, keys and subtitles.
 *
 * The `origin` field on every stream must be sent as `origin` query param
 * to the chosen proxy so the upstream receives the correct Referer/Origin.
 */
const DEFAULT_PROXY_ORIGIN = "https://melana-rs.onrender.com";
const DEFAULT_FAST_PROXY_ORIGIN = "https://spadik.vercel.app";
export const VIDCORE_ORIGIN = "https://vidfast.vc";

export const proxyOrigin = (
  import.meta.env.PUBLIC_STREAM_PROXY_ORIGIN || DEFAULT_PROXY_ORIGIN
).replace(/\/$/, "");
export const fastProxyOrigin = (
  (import.meta.env as any).PUBLIC_FAST_PROXY_ORIGIN ||
  DEFAULT_FAST_PROXY_ORIGIN
).replace(/\/$/, "");

export type StreamType = "hls" | "mp4" | "dash";

export interface SubtitleTrack {
  /** Direct URL to the subtitle file (vtt or srt). */
  url: string;
  /** Language name, e.g. "English". */
  lang: string;
  /** Optional format hint, e.g. "srt". */
  format?: string;
  /** Back-compat aliases: old code used file/label */
  file?: string;
  label?: string;
}

export interface Stream {
  /** Human-readable server name, e.g. "vRapid" */
  name: string;
  /** Origin URL to use as RefererOrigin header during playback */
  origin: string;
  /** Direct media URL (m3u8 playlist or mp4 file) */
  url: string;
  /** Container type */
  type: StreamType;
  /** Subtitle / caption tracks */
  tracks: SubtitleTrack[];
  /** Derived: true if server name suggests 4K / 2160p */
  is4k: boolean;
}

/** Back-compat: old StreamSource shape */
export interface StreamSource {
  url: string;
  origin: string;
  type: StreamType;
  tracks: SubtitleTrack[];
  is4k: boolean;
  /** legacy fields */
  noReferrer?: boolean;
  englishTrackIndex?: number | null;
  title?: string | null;
  tmdbId?: number | null;
}

/** Back-compat wrapper – new streams are flat, but we keep server/result shape for existing callers */
export interface StreamServer {
  name: string;
  description?: string;
}

export interface StreamItem {
  server: StreamServer;
  result: StreamSource;
}

export interface GetStreamResult {
  streams: Stream[];
}

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

function buildProxyUrl(
  baseOrigin: string,
  url: string,
  origin?: string | boolean | null,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ url });
  if (typeof origin === "string" && origin) {
    params.set("origin", origin);
  } else if (typeof origin === "boolean") {
    // legacy: noReferrer boolean – false means attach VIDCORE_ORIGIN
    if (!origin) params.set("origin", VIDCORE_ORIGIN);
  }
  for (const [k, v] of Object.entries(extra)) {
    params.set(k, v);
  }
  return `${baseOrigin}/proxy?${params}`;
}

/**
 * Wrap an arbitrary media URL in the stream proxy. The provider origin is
 * attached as `origin` query param. For unified streams this is the per-stream
 * `origin` field. For legacy callers passing `noReferrer` boolean, the
 * behaviour is preserved.
 */
export function proxiedStreamUrl(
  url: string,
  origin?: string | boolean | null,
): string {
  return buildProxyUrl(proxyOrigin, url, origin);
}

/**
 * Proxied manifest URL. The stream proxy fetches the upstream .m3u8 (WAF
 * bypass) and rewrites every URL in it – variants, audio playlists, segments,
 * keys, subtitles – to the fast edge proxy via `proxy=<base>`.
 */
export function proxiedManifestUrl(
  url: string,
  origin?: string | boolean | null,
): string {
  return buildProxyUrl(proxyOrigin, url, origin, {
    proxy: fastProxyOrigin,
  });
}

/**
 * Fast segment proxy (e.g. spadik.vercel.app). Wraps every segment/key/
 * subtitle URL through a CDN/edge that is much faster than Render.
 * Requires the per-stream `origin` for auth.
 */
export function fastProxiedUrl(
  url: string,
  origin?: string | boolean | null,
): string {
  return buildProxyUrl(fastProxyOrigin, url, origin);
}

/** Alias – segments, subtitles, keys all go through the fast path */
export const proxiedSegmentUrl = fastProxiedUrl;

/** True when a URL already points at either proxy (avoids double-wrapping). */
export function isProxiedStreamUrl(url: string): boolean {
  return (
    url.startsWith(`${proxyOrigin}/proxy?`) ||
    url.startsWith(`${proxyOrigin}/proxy/`) ||
    url.startsWith(`${fastProxyOrigin}/proxy?`) ||
    url.startsWith(`${fastProxyOrigin}/proxy/`)
  );
}

/**
 * Extract the upstream URL from a proxied URL (both /proxy?url=… and /proxy/{base64json} forms).
 * Returns null if the url is not a proxy url or cannot be decoded.
 */
export function extractUpstreamUrl(proxiedUrl: string): string | null {
  try {
    const u = new URL(proxiedUrl);
    // Query form: /proxy?url=...
    const q = u.searchParams.get("url");
    if (q) return q;

    // Base64 JSON form: /proxy/{base64}
    // Path is /proxy/<payload>
    const match = u.pathname.match(/\/proxy\/([^/]+)\/?$/);
    if (match) {
      const b64 = match[1];
      // base64 may be url-safe; normalize
      const normalized = b64.replace(/-/g, "+").replace(/_/g, "/");
      const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
      try {
        const jsonStr = atob(padded);
        const obj = JSON.parse(jsonStr);
        if (obj && typeof obj.url === "string") return obj.url;
      } catch {
        // may be plain base64-encoded url string?
        try {
          return atob(padded);
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // Not a valid URL – could be blob: or relative, ignore
  }
  return null;
}

/** Does the URL look like an HLS manifest (.m3u8 / .m3u) ? */
export function isManifestUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".m3u8") || pathname.endsWith(".m3u");
  } catch {
    // For relative URLs, test string directly ignoring query
    const lower = url.split("?")[0].split("#")[0].toLowerCase();
    return lower.endsWith(".m3u8") || lower.endsWith(".m3u");
  }
}

export function isMp4Url(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".mp4");
  } catch {
    const lower = url.split("?")[0].split("#")[0].toLowerCase();
    return lower.endsWith(".mp4");
  }
}

export function resolveRelativeUrl(relativeOrAbsolute: string, base: string): string {
  try {
    if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
    return new URL(relativeOrAbsolute, base).href;
  } catch {
    return relativeOrAbsolute;
  }
}

/**
 * Returns a proxied playback URL appropriate for the stream type.
 *  - hls: via melana-rs manifest proxy with fast proxy rewriter
 *  - mp4/dash: via spadik fast proxy directly
 * mp4 does NOT need hls.js – the browser can play it natively.
 */
export function getProxiedPlaybackUrl(stream: Stream): string {
  const upstream = isProxiedStreamUrl(stream.url)
    ? extractUpstreamUrl(stream.url) || stream.url
    : stream.url;
  if (stream.type === "hls") {
    return proxiedManifestUrl(upstream, stream.origin);
  }
  // mp4, dash, or unknown – single file via fast proxy
  return fastProxiedUrl(upstream, stream.origin);
}

interface RawTrack {
  file?: unknown;
  label?: unknown;
  url?: unknown;
  lang?: unknown;
  format?: unknown;
}

function parseTrack(raw: unknown): SubtitleTrack | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as RawTrack;
  // New spec: { url, lang, format? }
  if (typeof t.url === "string" && t.url) {
    const lang =
      typeof t.lang === "string" && t.lang ? t.lang : "Subtitle";
    const track: SubtitleTrack = {
      url: t.url,
      lang,
      file: t.url,
      label: lang,
    };
    if (typeof t.format === "string" && t.format) track.format = t.format;
    return track;
  }
  // Legacy spec: { file, label }
  if (typeof t.file === "string" && t.file) {
    const label =
      typeof t.label === "string" && t.label ? t.label : "Subtitle";
    return {
      url: t.file,
      lang: label,
      file: t.file,
      label,
    };
  }
  return null;
}

function parseUnifiedStream(payload: any): Stream | null {
  if (!payload || typeof payload !== "object") return null;
  // Detect legacy nested shape vs flat unified shape
  // Unified shape has name/origin/url/type at top level.
  // Legacy shape has server/result nesting – handled separately.
  if (typeof payload.name !== "string" || !payload.name) return null;
  if (typeof payload.origin !== "string" || !payload.origin) return null;
  if (typeof payload.url !== "string" || !payload.url) return null;

  let type: StreamType = "hls";
  if (payload.type === "hls" || payload.type === "mp4" || payload.type === "dash") {
    type = payload.type;
  } else if (typeof payload.type === "string") {
    const lower = payload.type.toLowerCase();
    if (lower === "hls" || lower === "mp4" || lower === "dash") {
      type = lower as StreamType;
    } else {
      // infer from URL extension
      const urlLower = payload.url.split("?")[0].toLowerCase();
      if (urlLower.endsWith(".mp4")) type = "mp4";
      else if (urlLower.endsWith(".mpd")) type = "dash";
      else type = "hls";
    }
  } else {
    const urlLower = payload.url.split("?")[0].toLowerCase();
    if (urlLower.endsWith(".mp4")) type = "mp4";
    else if (urlLower.endsWith(".mpd")) type = "dash";
  }

  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks
        .map((raw: unknown) => parseTrack(raw))
        .filter((v: SubtitleTrack | null): v is SubtitleTrack => v !== null)
    : [];

  // derive is4k from name or explicit flag
  let is4k = false;
  if (typeof payload.name === "string" && /4k|2160p/i.test(payload.name)) is4k = true;
  if (payload["4kAvailable"] === true) is4k = true;
  if (typeof payload.is4k === "boolean") is4k = payload.is4k;

  return {
    name: payload.name,
    origin: payload.origin,
    url: payload.url,
    type,
    tracks,
    is4k,
  };
}

function parseLegacyStreamSource(payload: any): StreamSource | null {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.url !== "string" || !payload.url) {
    return null;
  }

  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks
        .map((raw: unknown) => parseTrack(raw))
        .filter((v: SubtitleTrack | null): v is SubtitleTrack => v !== null)
    : [];

  const englishTrackIndex =
    typeof payload.englishTrackIndex === "number" &&
    Number.isInteger(payload.englishTrackIndex) &&
    payload.englishTrackIndex >= 0 &&
    payload.englishTrackIndex < tracks.length
      ? payload.englishTrackIndex
      : null;

  // Legacy had noReferrer boolean – keep for back-compat
  const noReferrer = payload.noReferrer === true;
  // Map legacy track shape to new: keep file/label aliases already set in parseTrack

  return {
    url: payload.url,
    origin: noReferrer ? "" : VIDCORE_ORIGIN,
    type: isManifestUrl(payload.url) ? "hls" : isMp4Url(payload.url) ? "mp4" : "hls",
    tracks,
    is4k: payload["4kAvailable"] === true,
    noReferrer,
    englishTrackIndex,
    title: typeof payload.title === "string" ? payload.title : null,
    tmdbId: typeof payload.tmdbId === "number" ? payload.tmdbId : null,
  };
}

export async function getStream(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<GetStreamResult> {
  const path =
    mediaType === "movie"
      ? `/sources/movie/${tmdbId}`
      : `/sources/tv/${tmdbId}/${season}/${episode}`;
  const response = await fetch(`${proxyOrigin}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    // For the new unified endpoint:
    // 400 -> invalid id, 502 -> both providers failed (body {streams:[]})
    // Mirror old error handling but surface status.
    throw new StreamError(`The stream service returned ${response.status}.`);
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new StreamError("The stream service returned an invalid response.");
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.streams)) {
    const streams: Stream[] = [];
    for (const rawStream of payload.streams) {
      if (!rawStream || typeof rawStream !== "object") continue;

      // Try unified flat shape first
      const unified = parseUnifiedStream(rawStream);
      if (unified) {
        streams.push(unified);
        continue;
      }

      // Fallback: legacy nested shape { server, result }
      // This keeps /vidfast compatibility if called via fallback path
      if ("result" in (rawStream as any) || "server" in (rawStream as any)) {
        const legacyParsed = parseLegacyStreamSource((rawStream as any).result);
        if (legacyParsed) {
          const rawServer = (rawStream as any).server || {};
          streams.push({
            name: typeof rawServer.name === "string" ? rawServer.name : "Unknown",
            origin: legacyParsed.origin,
            url: legacyParsed.url,
            type: legacyParsed.type,
            tracks: legacyParsed.tracks,
            is4k: legacyParsed.is4k,
          });
        }
      }
    }

    if (streams.length === 0) {
      throw new StreamError(
        "No playable video sources were returned for this title.",
      );
    }

    return { streams };
  }

  // Fallback to old single-source format (legacy)
  const singleLegacy = parseLegacyStreamSource(payload);
  if (singleLegacy) {
    return {
      streams: [
        {
          name: "Default",
          origin: singleLegacy.origin,
          url: singleLegacy.url,
          type: singleLegacy.type,
          tracks: singleLegacy.tracks,
          is4k: singleLegacy.is4k,
        },
      ],
    };
  }

  // Also try unified single object (just in case backend returns single stream object)
  const singleUnified = parseUnifiedStream(payload);
  if (singleUnified) {
    return { streams: [singleUnified] };
  }

  throw new StreamError(
    "No playable video sources were returned for this title.",
  );
}
