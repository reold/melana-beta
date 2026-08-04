import type { PageServerLoad } from "./$types";
import { fetchCatalogPage } from "$lib/catalog/repository";
import {
  DEFAULT_SORT,
  DEFAULT_TYPES,
  sortToBrowseSort,
  typeToMediaType,
} from "$lib/browse/filters";
import type { CatalogSnapshot } from "$lib/catalog/catalog-state.svelte";
import type { MediaType } from "$lib/tmdb/types";

/**
 * Pre-fetches the default browse catalog at build/prerender time so the
 * static page ships with the first page of titles already baked in (poster
 * images still load lazily from the TMDB image CDN at runtime).
 *
 * During `vite build` this runs once per prerendered page, so the daily
 * GitHub Actions build keeps the shipped catalog fresh against the real TMDB
 * responses. In dev it runs per request, which is fine.
 *
 * Any failure is swallowed: the page then falls back to its regular
 * client-side fetch, and the build never breaks because of an API hiccup.
 */
export const load: PageServerLoad = async (): Promise<{
  prefill: CatalogSnapshot | null;
}> => {
  const mediaTypes: MediaType[] = DEFAULT_TYPES.map(
    (tag) => typeToMediaType[tag],
  );
  const sort = sortToBrowseSort[DEFAULT_SORT];

  try {
    const result = await fetchCatalogPage({
      query: "",
      mediaTypes,
      sort,
      page: 1,
    });

    if (result.items.length === 0) return { prefill: null };

    return {
      prefill: {
        filters: { query: "", mediaTypes, sort },
        items: result.items,
        nextPage: 2,
        hasMore: result.hasMore,
      },
    };
  } catch {
    return { prefill: null };
  }
};
