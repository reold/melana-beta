import { fetchCatalogPage } from "./repository";
import {
  mediaKey,
  type BrowseSort,
  type MediaSummary,
  type MediaType,
} from "$lib/tmdb/types";

export interface CatalogFilters {
  query: string;
  mediaTypes: MediaType[];
  sort: BrowseSort;
}

/** Serialisable view of a loaded catalog, used to restore it without refetching. */
export interface CatalogSnapshot {
  filters: CatalogFilters;
  items: MediaSummary[];
  nextPage: number;
  hasMore: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeFilters(filters: CatalogFilters): CatalogFilters {
  return {
    query: filters.query.trim(),
    mediaTypes: [...new Set(filters.mediaTypes)],
    sort: filters.sort,
  };
}

function filtersKey(filters: CatalogFilters): string {
  return [
    filters.query.trim().toLocaleLowerCase(),
    [...filters.mediaTypes].sort().join(","),
    // Sort does not affect search-mode requests, so it must not restart a search.
    filters.query.trim() ? "search-relevance" : filters.sort,
  ].join("|");
}

function mergeUnique(
  existing: MediaSummary[],
  incoming: MediaSummary[],
): MediaSummary[] {
  const keys = new Set(existing.map(mediaKey));
  return [...existing, ...incoming.filter((item) => !keys.has(mediaKey(item)))];
}

/**
 * One controller owns every request in a catalog generation. Changing a filter
 * aborts that generation, including any in-flight infinite-scroll page.
 */
export class CatalogState {
  items = $state<MediaSummary[]>([]);
  loading = $state(false);
  loadingMore = $state(false);
  hasMore = $state(true);
  error = $state<string | null>(null);
  loadMoreError = $state<string | null>(null);

  #filters: CatalogFilters | null = null;
  #filtersKey = "";
  #generation = 0;
  #nextPage = 1;
  #controller: AbortController | null = null;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;

  setFilters(filters: CatalogFilters, searchDebounceMs = 300) {
    const normalized = normalizeFilters(filters);
    const nextKey = filtersKey(normalized);
    if (nextKey === this.#filtersKey) return;

    this.#cancelCurrentGeneration();
    this.#filters = normalized;
    this.#filtersKey = nextKey;
    this.#generation += 1;
    this.#nextPage = 1;
    this.items = [];
    this.hasMore = true;
    this.error = null;
    this.loadMoreError = null;
    this.loadingMore = false;
    this.loading = true;

    const generation = this.#generation;
    this.#controller = new AbortController();
    const delay = normalized.query ? searchDebounceMs : 0;

    if (delay > 0) {
      this.#searchTimer = setTimeout(() => {
        this.#searchTimer = null;
        void this.#loadFirstPage(
          generation,
          normalized,
          this.#controller?.signal,
        );
      }, delay);
      return;
    }

    void this.#loadFirstPage(generation, normalized, this.#controller.signal);
  }

  async loadMore() {
    if (
      this.loading ||
      this.loadingMore ||
      !this.hasMore ||
      !this.#filters ||
      !this.#controller
    )
      return;

    const generation = this.#generation;
    const filters = this.#filters;
    const page = this.#nextPage;
    const signal = this.#controller.signal;
    this.loadingMore = true;
    this.loadMoreError = null;

    try {
      const result = await fetchCatalogPage({ ...filters, page, signal });
      if (signal.aborted || generation !== this.#generation) return;

      this.items = mergeUnique(this.items, result.items);
      this.hasMore = result.hasMore;
      this.#nextPage = page + 1;
    } catch (error) {
      if (!isAbortError(error) && generation === this.#generation) {
        this.loadMoreError = "Could not load more titles. Try again.";
      }
    } finally {
      if (generation === this.#generation) this.loadingMore = false;
    }
  }

  retry() {
    if (!this.#filters) return;
    this.#filtersKey = "";
    this.setFilters(this.#filters, 0);
  }

  /** Everything needed to rebuild this catalog later, or `null` before a first load. */
  snapshot(): CatalogSnapshot | null {
    if (!this.#filters || this.loading) return null;
    return {
      filters: this.#filters,
      // Plain data: the snapshot outlives this instance's reactive graph and
      // has to survive `JSON.stringify`.
      items: $state.snapshot(this.items) as MediaSummary[],
      nextPage: this.#nextPage,
      hasMore: this.hasMore,
    };
  }

  /**
   * Adopts a previously captured catalog without hitting the network. A
   * following `setFilters` with the same filters is then a no-op, so a restored
   * page renders its old results on the first frame and keeps paginating from
   * where it left off.
   */
  hydrate(snapshot: CatalogSnapshot) {
    this.#cancelCurrentGeneration();

    const normalized = normalizeFilters(snapshot.filters);
    this.#filters = normalized;
    this.#filtersKey = filtersKey(normalized);
    this.#generation += 1;
    this.#nextPage = Math.max(1, Math.floor(snapshot.nextPage));
    this.#controller = new AbortController();

    this.items = [...snapshot.items];
    this.hasMore = snapshot.hasMore;
    this.loading = false;
    this.loadingMore = false;
    this.error = null;
    this.loadMoreError = null;
  }

  destroy() {
    this.#cancelCurrentGeneration();
  }

  async #loadFirstPage(
    generation: number,
    filters: CatalogFilters,
    signal: AbortSignal | undefined,
  ) {
    try {
      const result = await fetchCatalogPage({ ...filters, page: 1, signal });
      if (signal?.aborted || generation !== this.#generation) return;

      this.items = result.items;
      this.hasMore = result.hasMore;
      this.#nextPage = 2;
    } catch (error) {
      if (!isAbortError(error) && generation === this.#generation) {
        this.error =
          "Could not load titles. Check your connection and try again.";
        this.hasMore = false;
      }
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  #cancelCurrentGeneration() {
    if (this.#searchTimer) clearTimeout(this.#searchTimer);
    this.#searchTimer = null;
    this.#controller?.abort();
    this.#controller = null;
  }
}
