export type MediaType = "movie" | "tv";

export type BrowseSort = "popularity" | "rating" | "newest";

export interface MediaSummary {
  id: number;
  mediaType: MediaType;
  title: string;
  posterPath: string | null;
  backdropPath: string | null;
  releaseDate: string | null;
  rating: number | null;
  voteCount: number | null;
  popularity: number | null;
  overview: string;
}

export interface CastMember {
  id: number;
  name: string;
  character: string;
  profilePath: string | null;
}

export interface MediaDetails extends MediaSummary {
  tagline: string | null;
  genres: string[];
  runtime: number | null;
  status: string | null;
  originalLanguage: string | null;
  cast: CastMember[];
  numberOfSeasons: number | null;
  numberOfEpisodes: number | null;
  networks: string[];
  creators: string[];
  seasons: {
    name: string;
    seasonNumber: number;
    episodeCount: number | null;
  }[];
}

export interface CatalogPage {
  items: MediaSummary[];
  hasMore: boolean;
}

export interface CatalogRequest {
  query: string;
  mediaTypes: MediaType[];
  sort: BrowseSort;
  page: number;
  signal?: AbortSignal;
}

export function mediaKey(item: Pick<MediaSummary, "id" | "mediaType">): string {
  return `${item.mediaType}:${item.id}`;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

/** Structural check for values coming back from storage or other untrusted input. */
export function isMediaSummary(value: unknown): value is MediaSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;

  return (
    typeof item.id === "number" &&
    (item.mediaType === "movie" || item.mediaType === "tv") &&
    typeof item.title === "string" &&
    typeof item.overview === "string" &&
    isNullableString(item.posterPath) &&
    isNullableString(item.backdropPath) &&
    isNullableString(item.releaseDate) &&
    isNullableNumber(item.rating) &&
    isNullableNumber(item.voteCount) &&
    isNullableNumber(item.popularity)
  );
}
