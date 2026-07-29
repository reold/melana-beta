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
const VIDCORE_ORIGIN = "https://vidcore.net";
const proxyOrigin = (
  import.meta.env.PUBLIC_STREAM_PROXY_ORIGIN || DEFAULT_PROXY_ORIGIN
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

interface VidCoreResponse {
  url?: unknown;
  noReferrer?: unknown;
  "4kAvailable"?: unknown;
  tracks?: unknown;
  englishTrackIndex?: unknown;
  title?: unknown;
  tmdbId?: unknown;
}

/**
 * Wrap an arbitrary media URL in the stream proxy. The provider origin is
 * attached unless the source explicitly requires no referrer, matching how
 * VidCore signals referrer handling via its `noReferrer` field.
 * URLSearchParams safely preserves any signed query string.
 */
export function proxiedStreamUrl(url: string, noReferrer = false): string {
  const params = new URLSearchParams({ url });
  if (!noReferrer) params.set("origin", VIDCORE_ORIGIN);
  return `${proxyOrigin}/proxy?${params}`;
}

/** True when a URL already points at the stream proxy (avoids double-wrapping). */
export function isProxiedStreamUrl(url: string): boolean {
  return url.startsWith(`${proxyOrigin}/proxy?`);
}

export async function getStream(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<StreamSource> {
  const path =
    mediaType === "movie"
      ? `/vidcore/movie/${tmdbId}`
      : `/vidcore/tv/${tmdbId}/${season}/${episode}`;
  const response = await fetch(`${proxyOrigin}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new StreamError(`The stream service returned ${response.status}.`);
  }

  let payload: VidCoreResponse;
  try {
    payload = (await response.json()) as VidCoreResponse;
  } catch {
    throw new StreamError("The stream service returned an invalid response.");
  }

  if (typeof payload.url !== "string" || !payload.url) {
    throw new StreamError("No playable video sources were returned for this title.");
  }

  const tracks = Array.isArray(payload.tracks)
    ? payload.tracks.flatMap((raw): SubtitleTrack[] => {
        if (!raw || typeof raw !== "object") return [];
        const track = raw as RawTrack;
        if (typeof track.file !== "string" || !track.file) return [];
        return [{
          file: track.file,
          label:
            typeof track.label === "string" && track.label ? track.label : "Subtitle",
        }];
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
