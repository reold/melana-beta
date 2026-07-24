<script lang="ts">
  import { onMount } from "svelte";
  import MediaPosterCard from "./MediaPosterCard.svelte";
  import type { MediaSummary } from "$lib/tmdb/types";

  interface Props {
    items?: MediaSummary[];
    loading?: boolean;
    loadingMore?: boolean;
    hasMore?: boolean;
    error?: string | null;
    loadMoreError?: string | null;
    onLoadMore?: () => void;
    onRetry?: () => void;
    onSelect?: (item: MediaSummary) => void;
  }

  let {
    items = [],
    loading = false,
    loadingMore = false,
    hasMore = false,
    error = null,
    loadMoreError = null,
    onLoadMore = () => {},
    onRetry = () => {},
    onSelect = () => {},
  }: Props = $props();

  const columns = 2;
  const horizontalPadding = 40;
  const columnGap = 16;
  const rowGap = 16;
  const overscanRows = 3;

  let element = $state<HTMLElement | null>(null);
  let width = $state(0);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);

  const cardWidth = $derived(
    Math.max(0, (width - horizontalPadding - columnGap) / columns),
  );
  // Poster art is 3:4; the Apple-style metadata rail below it is 32px high.
  const rowHeight = $derived(cardWidth * (4 / 3) + 32 + rowGap);
  const rowCount = $derived(Math.ceil(items.length / columns));
  const startRow = $derived(
    rowHeight
      ? Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows)
      : 0,
  );
  const endRow = $derived(
    rowHeight
      ? Math.min(
          rowCount,
          Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscanRows,
        )
      : 0,
  );
  const virtualRows = $derived(
    Array.from(
      { length: Math.max(0, endRow - startRow) },
      (_, index) => startRow + index,
    ),
  );
  const gridHeight = $derived(Math.max(0, rowCount * rowHeight - rowGap));

  function updateViewport() {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    width = element.clientWidth;
    viewportHeight = window.innerHeight;
    scrollTop = Math.max(0, -rect.top);
  }

  $effect(() => {
    // Request before the final rows become visible. CatalogState prevents duplicates.
    if (
      !loading &&
      !loadingMore &&
      hasMore &&
      rowCount > 0 &&
      endRow >= rowCount - 4
    ) {
      onLoadMore();
    }
  });

  onMount(() => {
    const resizeObserver = new ResizeObserver(updateViewport);
    if (element) resizeObserver.observe(element);

    window.addEventListener("scroll", updateViewport, { passive: true });
    window.addEventListener("resize", updateViewport, { passive: true });
    updateViewport();

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  });
</script>

<section
  bind:this={element}
  class="relative mt-6 px-5 pb-28"
  aria-live="polite"
>
  {#if loading && items.length === 0}
    <div class="grid grid-cols-2 gap-4" aria-label="Loading titles">
      {#each Array(6) as _}
        <div class="animate-pulse overflow-hidden rounded-2xl bg-app-surface">
          <div class="aspect-[3/4] bg-app-surface-hover"></div>
          <div class="h-8"></div>
        </div>
      {/each}
    </div>
  {:else if error}
    <div
      class="rounded-[10px] border border-apple-red/60 bg-apple-red/15 px-4 py-3 text-sm text-app-label"
    >
      <p>{error}</p>
      <button
        class="mt-3 rounded-[8px] bg-apple-red px-3 py-1.5 font-semibold text-apple-white"
        onclick={onRetry}
      >
        Retry
      </button>
    </div>
  {:else if items.length === 0}
    <p class="py-12 text-center text-app-secondary-label">No titles found.</p>
  {:else}
    <div
      class="relative"
      style={`height: ${gridHeight + (loadingMore || loadMoreError ? 56 : 0)}px`}
    >
      {#each virtualRows as rowIndex (rowIndex)}
        <div
          class="absolute inset-x-0 grid grid-cols-2 gap-x-4"
          style={`top: ${rowIndex * rowHeight}px`}
        >
          {#each items.slice(rowIndex * columns, rowIndex * columns + columns) as item (`${item.mediaType}:${item.id}`)}
            <MediaPosterCard {item} {onSelect} />
          {/each}
        </div>
      {/each}

      {#if loadingMore || loadMoreError}
        <div
          class="absolute inset-x-0 flex justify-center"
          style={`top: ${gridHeight + 16}px`}
        >
          {#if loadMoreError}
            <button
              class="text-sm font-semibold text-apple-blue"
              onclick={onLoadMore}>Try loading more</button
            >
          {:else}
            <span class="text-sm text-app-secondary-label">Loading more…</span>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>
