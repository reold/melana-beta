import type { BrowseSort, MediaType } from "$lib/tmdb/types";

/** Labels shown in the browse toolbar, and how they map onto catalog filters. */
export const SORT_OPTIONS = ["Popularity", "Rating", "Date"] as const;
export const TYPE_OPTIONS = ["TV Shows", "Movies"] as const;

export type SortOption = (typeof SORT_OPTIONS)[number];
export type TypeOption = (typeof TYPE_OPTIONS)[number];

export const DEFAULT_SORT: SortOption = "Popularity";
export const DEFAULT_TYPES: TypeOption[] = [...TYPE_OPTIONS];

export const typeToMediaType: Record<TypeOption, MediaType> = {
  "TV Shows": "tv",
  Movies: "movie",
};

export const sortToBrowseSort: Record<SortOption, BrowseSort> = {
  Popularity: "popularity",
  Rating: "rating",
  Date: "newest",
};

export function isSortOption(value: unknown): value is SortOption {
  return SORT_OPTIONS.includes(value as SortOption);
}

export function isTypeOption(value: unknown): value is TypeOption {
  return TYPE_OPTIONS.includes(value as TypeOption);
}
