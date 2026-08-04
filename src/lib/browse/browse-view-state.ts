import type { CatalogSnapshot } from "$lib/catalog/catalog-state.svelte";
import { defineViewState } from "$lib/state/view-state";
import { isMediaSummary, type MediaSummary } from "$lib/tmdb/types";
import {
  DEFAULT_SORT,
  DEFAULT_TYPES,
  isSortOption,
  isTypeOption,
  type SortOption,
  type TypeOption,
} from "./filters";

/**
 * Everything the browse screen needs to look untouched after a Back navigation:
 * the query and filters that produced the list, the list itself, where the user
 * was in it, and whether a title's details sheet was open on top.
 */
export interface BrowseSnapshot {
  query: string;
  sort: SortOption;
  types: TypeOption[];
  scrollY: number;
  details: {
    open: boolean;
    item: MediaSummary | null;
    /** Active sheet snap point, or `null` for the sheet's default. */
    snapPoint: number | null;
  };
  catalog: CatalogSnapshot | null;
}

/**
 * Results above this count are not written to sessionStorage — the memory tier
 * still restores them for a normal Back, and a reloaded document refetches from
 * page one instead of blowing the storage quota.
 */
const MAX_PERSISTED_ITEMS = 400;

function isCatalogSnapshot(value: unknown): value is CatalogSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  const filters = snapshot.filters as Record<string, unknown> | undefined;

  return (
    !!filters &&
    typeof filters === "object" &&
    typeof filters.query === "string" &&
    Array.isArray(filters.mediaTypes) &&
    filters.mediaTypes.every((type) => type === "movie" || type === "tv") &&
    (filters.sort === "popularity" ||
      filters.sort === "rating" ||
      filters.sort === "newest") &&
    Array.isArray(snapshot.items) &&
    snapshot.items.every(isMediaSummary) &&
    typeof snapshot.nextPage === "number" &&
    typeof snapshot.hasMore === "boolean"
  );
}

export const browseViewState = defineViewState<BrowseSnapshot>({
  key: "browse",
  version: 1,

  toStorage(value) {
    const tooLarge = (value.catalog?.items.length ?? 0) > MAX_PERSISTED_ITEMS;
    return tooLarge ? { ...value, catalog: null } : value;
  },

  fromStorage(raw) {
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    const details = (value.details ?? {}) as Record<string, unknown>;
    const catalog = isCatalogSnapshot(value.catalog) ? value.catalog : null;
    const types = Array.isArray(value.types)
      ? value.types.filter(isTypeOption)
      : [];

    return {
      query: typeof value.query === "string" ? value.query : "",
      sort: isSortOption(value.sort) ? value.sort : DEFAULT_SORT,
      types: types.length > 0 ? types : [...DEFAULT_TYPES],
      scrollY: typeof value.scrollY === "number" ? Math.max(0, value.scrollY) : 0,
      details: {
        open: details.open === true && isMediaSummary(details.item),
        item: isMediaSummary(details.item) ? details.item : null,
        snapPoint:
          typeof details.snapPoint === "number" ? details.snapPoint : null,
      },
      catalog,
    };
  },
});
