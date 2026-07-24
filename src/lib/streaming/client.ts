import type { MediaType } from "$lib/tmdb/types";

/** The public API that resolves a TMDB title into playable sources. */
const DEFAULT_PROXY_ORIGIN = "https://melana-rs.onrender.com";
const proxyOrigin = (
  import.meta.env.PUBLIC_STREAM_PROXY_ORIGIN || DEFAULT_PROXY_ORIGIN
).replace(/\/$/, "");

export interface StreamQuality {
  label: string;
  url: string;
  type: string;
  codecName: string | null;
}

interface ProxyQuality {
  url?: unknown;
  type?: unknown;
  codecName?: unknown;
}

interface ProxyResponse {
  stream?: {
    qualities?: Record<string, ProxyQuality>;
  };
}

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

function normaliseUrl(value: string): string {
  // A URL should arrive as JSON, but accepting HTML-escaped ampersands makes
  // the player resilient to proxies that serialise an already-escaped value.
  return value.replaceAll("&amp;", "&");
}

function qualityRank(label: string): number {
  const parsed = Number.parseInt(label, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getStream(
  mediaType: MediaType,
  tmdbId: number,
  season?: number,
  episode?: number,
  signal?: AbortSignal,
): Promise<StreamQuality[]> {
  const path =
    mediaType === "movie"
      ? `/vidlink/movie/${tmdbId}`
      : `/vidlink/tv/${tmdbId}/${season}/${episode}`;
  const response = await fetch(`${proxyOrigin}${path}`, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new StreamError(`The stream service returned ${response.status}.`);
  }

  let payload: ProxyResponse;
  try {
    payload = (await response.json()) as ProxyResponse;
  } catch {
    throw new StreamError("The stream service returned an invalid response.");
  }

  const qualities = Object.entries(payload.stream?.qualities ?? {})
    .flatMap(([label, source]) => {
      if (typeof source.url !== "string" || !source.url) return [];
      return [{
        label,
        url: normaliseUrl(source.url),
        type: typeof source.type === "string" ? source.type : "video/mp4",
        codecName: typeof source.codecName === "string" ? source.codecName : null,
      }];
    })
    .sort((a, b) => qualityRank(b.label) - qualityRank(a.label));

  if (!qualities.length) {
    throw new StreamError("No playable video sources were returned for this title.");
  }

  return qualities;
}
