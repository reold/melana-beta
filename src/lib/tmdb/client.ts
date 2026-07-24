import { PUBLIC_TMDB_API_KEY } from "$env/static/public";
import type { BrowseSort, MediaSummary, MediaType } from "./types";

const API_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";

interface TmdbResult {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string;
  first_air_date?: string;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  overview?: string;
  media_type?: "movie" | "tv" | "person";
}

interface TmdbPage<T> {
  page: number;
  results: T[];
  total_pages: number;
}

export class TmdbError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "TmdbError";
  }
}

function requireApiKey(): string {
  if (!PUBLIC_TMDB_API_KEY) {
    throw new Error(
      "Missing PUBLIC_TMDB_API_KEY. Add it to your public build environment.",
    );
  }
  return PUBLIC_TMDB_API_KEY;
}

async function request<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  signal?: AbortSignal,
): Promise<T> {
  const search = new URLSearchParams({ api_key: requireApiKey() });

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }

  const response = await fetch(`${API_BASE}${path}?${search}`, { signal });
  if (!response.ok) {
    throw new TmdbError(
      response.status,
      `TMDB request failed (${response.status}).`,
    );
  }

  return response.json() as Promise<T>;
}

function normalize(raw: TmdbResult, fallbackType: MediaType): MediaSummary {
  const mediaType =
    raw.media_type === "tv" || raw.media_type === "movie"
      ? raw.media_type
      : fallbackType;

  return {
    id: raw.id,
    mediaType,
    title: raw.title ?? raw.name ?? "Untitled",
    posterPath: raw.poster_path ?? null,
    backdropPath: raw.backdrop_path ?? null,
    releaseDate: raw.release_date ?? raw.first_air_date ?? null,
    rating: typeof raw.vote_average === "number" ? raw.vote_average : null,
    voteCount: typeof raw.vote_count === "number" ? raw.vote_count : null,
    popularity: typeof raw.popularity === "number" ? raw.popularity : null,
    overview: raw.overview ?? "",
  };
}

function discoverSort(mediaType: MediaType, sort: BrowseSort): string {
  if (sort === "newest") {
    return mediaType === "movie"
      ? "primary_release_date.desc"
      : "first_air_date.desc";
  }
  if (sort === "rating") return "vote_average.desc";
  return "popularity.desc";
}

export async function discoverMedia(
  mediaType: MediaType,
  sort: BrowseSort,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: MediaSummary[]; hasMore: boolean }> {
  const data = await request<TmdbPage<TmdbResult>>(
    `/discover/${mediaType}`,
    {
      page,
      sort_by: discoverSort(mediaType, sort),
      include_adult: false,
      "vote_count.gte": sort === "rating" ? 100 : undefined,
    },
    signal,
  );

  return {
    items: data.results.map((item) => normalize(item, mediaType)),
    hasMore: data.page < data.total_pages,
  };
}

export async function searchMedia(
  mediaType: MediaType,
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: MediaSummary[]; hasMore: boolean }> {
  const data = await request<TmdbPage<TmdbResult>>(
    `/search/${mediaType}`,
    { query, page, include_adult: false },
    signal,
  );

  return {
    items: data.results.map((item) => normalize(item, mediaType)),
    hasMore: data.page < data.total_pages,
  };
}

export async function searchMixedMedia(
  query: string,
  page: number,
  signal?: AbortSignal,
): Promise<{ items: MediaSummary[]; hasMore: boolean }> {
  const data = await request<TmdbPage<TmdbResult>>(
    "/search/multi",
    { query, page, include_adult: false },
    signal,
  );

  const mediaItems = data.results.filter(
    (item): item is TmdbResult & { media_type: MediaType } =>
      item.media_type === "movie" || item.media_type === "tv",
  );

  return {
    items: mediaItems.map((item) => normalize(item, item.media_type)),
    hasMore: data.page < data.total_pages,
  };
}

export function tmdbPosterUrl(
  path: string | null,
  size: "w185" | "w342" | "w500" | "w780" = "w500",
): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}
