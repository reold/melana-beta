import type { MediaType } from "$lib/tmdb/types";

/**
 * The public API that resolves a TMDB title into a playable source.
 *
 * Stream sources are fetched through a small proxy (`melana-rs`) which both
 * scrapes the VidCore embed (the `/vidcore/...` JSON endpoints below) and
 * re-serves the underlying media with the correct origin/referrer headers (the
 * `/proxy` endpoint). VidCore returns a single adaptive-bitrate HLS playlist
 * rather than the per-quality files Vidlink used to expose.
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

export interface SubtitleTrack {
  file: string;
  label: string;
}

export interface StreamSource {
  /** Raw HLS playlist URL returned by the stream service. */
  url: string;
  /**
   * When `true` the source must be fetched without a Referer; otherwise the
   * provider origin is attached by the proxy. Surfaced from VidCore's response.
   */
  noReferrer: boolean;
  tracks: SubtitleTrack[];
  /** Index of the preferred English track within `tracks`, when known. */
  englishTrackIndex: number | null;
  is4k: boolean;
  title: string | null;
  tmdbId: number | null;
}

export interface StreamServer {
  name: string;
  description?: string;
}

export interface StreamItem {
  server: StreamServer;
  result: StreamSource;
}

export interface GetStreamResult {
  streams: StreamItem[];
}

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

interface RawTrack {
  file?: unknown;
  label?: unknown;
}

function buildProxyUrl(
  baseOrigin: string,
  url: string,
  noReferrer: boolean,
  extra: Record<string, string> = {},
): string {
  const params = new URLSearchParams({ url });
  if (!noReferrer) params.set("origin", VIDCORE_ORIGIN);
  for (const [k, v] of Object.entries(extra)) {
    params.set(k, v);
  }
  return `${baseOrigin}/proxy?${params}`;
}

/**
 * Wrap an arbitrary media URL in the stream proxy. The provider origin is
 * attached unless the source explicitly requires no referrer, matching how
 * VidCore signals referrer handling via its `noReferrer` field.
 * URLSearchParams safely preserves any signed query string.
 */
export function proxiedStreamUrl(url: string, noReferrer = false): string {
  return buildProxyUrl(proxyOrigin, url, noReferrer);
}

/**
 * Melana proxy with `raw=true` – returns the upstream .m3u8 body untouched,
 * with original URLs intact. Used for manifests so we can re-wrap segments
 * through a faster proxy ourselves.
 */
export function proxiedManifestRawUrl(url: string, noReferrer = false): string {
  return buildProxyUrl(proxyOrigin, url, noReferrer, { raw: "true" });
}

/**
 * Fast segment proxy (e.g. spadik.vercel.app). Wraps every segment/key/
 * subtitle URL through a CDN/edge that is much faster than Render.
 * Uses the same origin header (vidfast) for auth.
 */
export function fastProxiedUrl(url: string, noReferrer = false): string {
  return buildProxyUrl(fastProxyOrigin, url, noReferrer);
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

export function resolveRelativeUrl(relativeOrAbsolute: string, base: string): string {
  try {
    if (/^https?:\/\//i.test(relativeOrAbsolute)) return relativeOrAbsolute;
    return new URL(relativeOrAbsolute, base).href;
  } catch {
    return relativeOrAbsolute;
  }
}

function parseStreamSource(payload: any): StreamSource | null {
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.url !== "string" || !payload.url) {
    return null;
  }

  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks.flatMap((raw): SubtitleTrack[] => {
        if (!raw || typeof raw !== "object") return [];
        const track = raw as RawTrack;
        if (typeof track.file !== "string" || !track.file) return [];
        return [
          {
            file: track.file,
            label:
              typeof track.label === "string" && track.label
                ? track.label
                : "Subtitle",
          },
        ];
      })
    : [];

  const englishTrackIndex =
    typeof payload.englishTrackIndex === "number" &&
    Number.isInteger(payload.englishTrackIndex) &&
    payload.englishTrackIndex >= 0 &&
    payload.englishTrackIndex < tracks.length
      ? payload.englishTrackIndex
      : null;

  return {
    url: payload.url,
    noReferrer: payload.noReferrer === true,
    tracks,
    englishTrackIndex,
    is4k: payload["4kAvailable"] === true,
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
      ? `/vidfast/movie/${tmdbId}`
      : `/vidfast/tv/${tmdbId}/${season}/${episode}`;
  const response = await fetch(`${proxyOrigin}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new StreamError(`The stream service returned ${response.status}.`);
  }

  let payload: any;
  try {
    payload = await response.json();
  } catch {
    throw new StreamError("The stream service returned an invalid response.");
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.streams)) {
    const streams: StreamItem[] = [];
    for (const rawStream of payload.streams) {
      if (!rawStream || typeof rawStream !== "object") continue;
      const parsed = parseStreamSource(rawStream.result);
      if (parsed) {
        const rawServer = rawStream.server || {};
        streams.push({
          server: {
            name: typeof rawServer.name === "string" ? rawServer.name : "Unknown",
            description: typeof rawServer.description === "string" ? rawServer.description : undefined,
          },
          result: parsed,
        });
      }
    }

    if (streams.length === 0) {
      throw new StreamError(
        "No playable video sources were returned for this title.",
      );
    }

    return { streams };
  }

  // Fallback to old single-source format
  const singleParsed = parseStreamSource(payload);
  if (singleParsed) {
    return {
      streams: [
        {
          server: { name: "Default" },
          result: singleParsed,
        },
      ],
    };
  }

  throw new StreamError(
    "No playable video sources were returned for this title.",
  );
}
