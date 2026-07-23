import { discoverMedia, searchMedia, searchMixedMedia } from "$lib/tmdb/client";
import {
  mediaKey,
  type CatalogPage,
  type CatalogRequest,
  type MediaSummary,
} from "$lib/tmdb/types";

const MAX_CACHE_ENTRIES = 80;
const pageCache = new Map<string, CatalogPage>();

function cacheKey({ query, mediaTypes, sort, page }: CatalogRequest): string {
  const typeKey = [...mediaTypes].sort().join(",");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return normalizedQuery
    ? `search:${typeKey}:${normalizedQuery}:page:${page}`
    : `browse:${typeKey}:${sort}:page:${page}`;
}

function cachePage(key: string, page: CatalogPage): CatalogPage {
  if (pageCache.has(key)) pageCache.delete(key);
  pageCache.set(key, page);

  if (pageCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = pageCache.keys().next().value;
    if (oldestKey) pageCache.delete(oldestKey);
  }

  return page;
}

function unique(items: MediaSummary[]): MediaSummary[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = mediaKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareMedia(sort: CatalogRequest["sort"]) {
  if (sort === "rating") {
    return (a: MediaSummary, b: MediaSummary) =>
      (b.rating ?? -1) - (a.rating ?? -1);
  }

  if (sort === "newest") {
    return (a: MediaSummary, b: MediaSummary) => {
      const aDate = a.releaseDate ? Date.parse(a.releaseDate) : 0;
      const bDate = b.releaseDate ? Date.parse(b.releaseDate) : 0;
      return bDate - aDate;
    };
  }

  return (a: MediaSummary, b: MediaSummary) =>
    (b.popularity ?? -1) - (a.popularity ?? -1);
}

/** Fetches fulfilled pages only; aborted and failed requests never enter the cache. */
export async function fetchCatalogPage(
  request: CatalogRequest,
): Promise<CatalogPage> {
  const key = cacheKey(request);
  const cached = pageCache.get(key);
  if (cached) return cached;

  const mediaTypes = [...new Set(request.mediaTypes)];
  if (mediaTypes.length === 0) return { items: [], hasMore: false };

  const query = request.query.trim();

  if (query) {
    if (mediaTypes.length === 2) {
      const result = await searchMixedMedia(
        query,
        request.page,
        request.signal,
      );
      return cachePage(key, {
        items: unique(result.items),
        hasMore: result.hasMore,
      });
    }

    const result = await searchMedia(
      mediaTypes[0],
      query,
      request.page,
      request.signal,
    );
    return cachePage(key, {
      items: unique(result.items),
      hasMore: result.hasMore,
    });
  }

  const pages = await Promise.all(
    mediaTypes.map((mediaType) =>
      discoverMedia(mediaType, request.sort, request.page, request.signal),
    ),
  );

  const items = unique(pages.flatMap((page) => page.items)).sort(
    compareMedia(request.sort),
  );
  return cachePage(key, {
    items,
    hasMore: pages.some((page) => page.hasMore),
  });
}

export function clearCatalogMemoryCache() {
  pageCache.clear();
}
