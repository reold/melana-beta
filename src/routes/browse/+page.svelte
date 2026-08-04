<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { disableScrollHandling } from "$app/navigation";
  import ContourTexture from "$lib/assets/contour-texture.png";
  import Dropdown from "$lib/common/Dropdown.svelte";
  import TagsSelect from "$lib/common/TagSelect.svelte";
  import VirtualPosterGrid from "$lib/browse/VirtualPosterGrid.svelte";
  import MediaDetailsSheet, {
    COMPACT_SNAP_POINT,
    EXPANDED_SNAP_POINT,
  } from "$lib/browse/MediaDetailsSheet.svelte";
  import {
    browseViewState,
    type BrowseSnapshot,
  } from "$lib/browse/browse-view-state";
  import {
    DEFAULT_SORT,
    DEFAULT_TYPES,
    SORT_OPTIONS,
    TYPE_OPTIONS,
    isTypeOption,
    sortToBrowseSort,
    typeToMediaType,
    type SortOption,
  } from "$lib/browse/filters";
  import { CatalogState } from "$lib/catalog/catalog-state.svelte";
  import { readPageScrollY, restorePageScrollY } from "$lib/state/scroll";
  import type { MediaSummary } from "$lib/tmdb/types";

  interface Props {
    onSelect?: (item: MediaSummary) => void;
    onPlay?: (item: MediaSummary) => void;
  }

  let { onSelect = () => {}, onPlay = () => {} }: Props = $props();

  const catalog = new CatalogState();

  // Snapshot of this history entry, if the user is coming back to it. Read
  // before any state is initialised so the screen renders restored — query,
  // results, sheet and scroll — on its first frame instead of flashing
  // defaults and refetching.
  const restored = browseViewState.connect(captureViewState);

  let sortBy = $state<SortOption>(restored?.sort ?? DEFAULT_SORT);
  let includeTypes = $state<string[]>(restored?.types ?? [...DEFAULT_TYPES]);
  let searchQuery = $state(restored?.query ?? "");
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement | null>(null);
  let searchFocused = $state(false);
  let keyboardInset = $state(0);
  let searchFocusScrollY = 0;
  let preserveSearchScrollUntil = 0;
  let selectedItem = $state<MediaSummary | null>(restored?.details.item ?? null);
  // Opened after the scroll restore in onMount, never during initialisation.
  let detailsOpen = $state(false);
  let detailsSnapPoint = $state<number | string>(
    restored?.details.snapPoint === EXPANDED_SNAP_POINT
      ? EXPANDED_SNAP_POINT
      : COMPACT_SNAP_POINT,
  );

  if (restored?.catalog) catalog.hydrate(restored.catalog);

  const isSearchMode = $derived(searchQuery.trim().length > 0);
  const selectedMediaTypes = $derived(
    includeTypes.filter(isTypeOption).map((tag) => typeToMediaType[tag]),
  );

  function captureViewState(): BrowseSnapshot {
    return {
      query: searchQuery,
      sort: sortBy,
      types: includeTypes.filter(isTypeOption),
      scrollY: readPageScrollY(),
      details: {
        open: detailsOpen,
        item: selectedItem ? ($state.snapshot(selectedItem) as MediaSummary) : null,
        snapPoint:
          typeof detailsSnapPoint === "number" ? detailsSnapPoint : null,
      },
      catalog: catalog.snapshot(),
    };
  }

  // A changed query/filter/sort starts a new catalog generation. The controller
  // aborts all work from the old generation before a replacement can commit.
  $effect(() => {
    catalog.setFilters({
      query: searchQuery,
      mediaTypes: selectedMediaTypes,
      sort: sortToBrowseSort[sortBy],
    });
  });

  onDestroy(() => catalog.destroy());

  function restoreSearchScrollPosition() {
    if (searchFocused && Date.now() < preserveSearchScrollUntil) {
      window.scrollTo(0, searchFocusScrollY);
    }
  }

  function updateKeyboardInset() {
    const viewport = window.visualViewport;
    if (!viewport || !searchFocused) {
      keyboardInset = 0;
      return;
    }

    // VisualViewport is the reliable keyboard signal on iOS Safari. The
    // Virtual Keyboard API / keyboard-inset CSS environment variables are not.
    keyboardInset = Math.max(
      0,
      window.innerHeight - viewport.height - viewport.offsetTop,
    );
    restoreSearchScrollPosition();
  }

  onMount(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    viewport.addEventListener("resize", updateKeyboardInset);
    viewport.addEventListener("scroll", updateKeyboardInset);

    return () => {
      viewport.removeEventListener("resize", updateKeyboardInset);
      viewport.removeEventListener("scroll", updateKeyboardInset);
    };
  });

  onMount(() => {
    if (!restored) return;

    // SvelteKit's own scroll restoration runs against the page as it is right
    // after mount; take it over so the sheet and the grid are settled first.
    try {
      disableScrollHandling();
    } catch {
      // Only valid during a navigation — e.g. a dev HMR remount is not one.
    }

    const target = restored;
    let frame = 0;

    function settle(attempt: number) {
      restorePageScrollY(target.scrollY);

      // The virtual grid sizes itself from its measured width, so on a slow
      // first layout the document can still be too short to reach the old
      // offset. Give it one more frame before settling for what we got.
      if (attempt === 0 && window.scrollY < target.scrollY - 2) {
        frame = requestAnimationFrame(() => settle(attempt + 1));
        return;
      }

      // Reopening after the scroll restore lets the sheet's scroll lock capture
      // the right offset, so the page behind it stays where the user left it.
      if (target.details.open && target.details.item) detailsOpen = true;
    }

    frame = requestAnimationFrame(() => settle(0));

    return () => cancelAnimationFrame(frame);
  });

  function handleSearchFocus() {
    // Safari may scroll the layout viewport to reveal a fixed input. Preserve
    // the browse position while its keyboard-opening animation settles.
    searchFocusScrollY = window.scrollY;
    preserveSearchScrollUntil = Date.now() + 750;
    searchFocused = true;

    requestAnimationFrame(() => {
      updateKeyboardInset();
      restoreSearchScrollPosition();
    });
    window.setTimeout(restoreSearchScrollPosition, 120);
    window.setTimeout(restoreSearchScrollPosition, 360);
  }

  function handleSearchBlur() {
    searchFocused = false;
    preserveSearchScrollUntil = 0;
    keyboardInset = 0;
  }

  function handleSelect(item: MediaSummary) {
    selectedItem = item;
    detailsOpen = true;
    onSelect(item);
  }

  function openSearch() {
    searchOpen = true;
    // The input is conditionally rendered, so focus it once the panel mounts.
    window.setTimeout(() => searchInput?.focus(), 0);
  }

  function closeSearch() {
    searchOpen = false;
    searchInput?.blur();
  }

  function clearSearch() {
    searchQuery = "";
    searchInput?.focus();
  }
</script>

<svelte:head>
  <title>Browse Melana</title>
</svelte:head>

{#snippet sortIcon()}
  <svg
    class="h-4 w-4 shrink-0"
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
  >
    <path
      fill-rule="evenodd"
      d="M6.97 2.47a.75.75 0 0 1 1.06 0l4.5 4.5a.75.75 0 0 1-1.06 1.06L8.25 4.81V16.5a.75.75 0 0 1-1.5 0V4.81L3.53 8.03a.75.75 0 0 1-1.06-1.06l4.5-4.5Zm9.53 4.28a.75.75 0 0 1 .75.75v11.69l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 1 1 1.06-1.06l3.22 3.22V7.5a.75.75 0 0 1 .75-.75Z"
      clip-rule="evenodd"
    />
  </svg>
{/snippet}

<div
  data-svaul-drawer-wrapper
  class="min-h-screen bg-app-canvas text-app-label"
>
  <header class="relative overflow-hidden px-5 pb-4 pt-10">
    <div
      class="pointer-events-none absolute inset-0 mask-cover mask-center bg-linear-to-b from-apple-aqua from-80% to-black opacity-50"
      style="mask-image: url({ContourTexture});"
    ></div>
    <div class="texture-fade" aria-hidden="true"></div>
    <h1
      class="relative z-10 text-5xl font-extrabold leading-none tracking-tight"
    >
      Browse
    </h1>
  </header>

  <div
    class="no-scrollbar relative z-20 flex items-center gap-2.5 overflow-x-auto border-y border-app-separator bg-apple-white/[0.02] px-4 py-2.5"
    aria-label="Browse filters"
  >
    {#if !isSearchMode}
      <Dropdown
        options={[...SORT_OPTIONS]}
        bind:value={sortBy}
        triggerIcon={sortIcon}
      />
    {/if}

    <TagsSelect
      options={[...TYPE_OPTIONS]}
      bind:selected={includeTypes}
      min={1}
    />
  </div>

  <VirtualPosterGrid
    items={catalog.items}
    loading={catalog.loading}
    loadingMore={catalog.loadingMore}
    hasMore={catalog.hasMore}
    error={catalog.error}
    loadMoreError={catalog.loadMoreError}
    onLoadMore={() => catalog.loadMore()}
    onRetry={() => catalog.retry()}
    onSelect={handleSelect}
  />

  <div
    class="fixed inset-x-0 z-40 flex items-center gap-2 px-5 transition-transform duration-150"
    style={`bottom: calc(1.5rem + env(safe-area-inset-bottom)); transform: translateY(-${keyboardInset}px);`}
  >
    {#if searchOpen}
      <!-- Close the panel and return to the floating search button -->
      <button
        type="button"
        onclick={closeSearch}
        aria-label="Close search"
        class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-apple-gray/35 bg-app-surface/90 text-app-label shadow-lg backdrop-blur-xl transition-transform active:scale-95"
      >
        <svg
          class="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>

      <div
        class="flex flex-1 items-center rounded-2xl border border-apple-gray/35 bg-gradient-to-r from-app-surface/95 via-app-surface/90 to-app-surface/80 px-4 py-3 shadow-lg backdrop-blur-xl"
      >
        <input
          bind:this={searchInput}
          bind:value={searchQuery}
          type="text"
          inputmode="search"
          enterkeyhint="search"
          placeholder="Search titles..."
          aria-label="Search titles"
          onfocus={handleSearchFocus}
          onblur={handleSearchBlur}
          class="w-full bg-transparent text-[16px] font-semibold text-app-label placeholder-apple-gray-3 outline-none"
        />
        {#if searchQuery}
          <button
            type="button"
            onclick={clearSearch}
            aria-label="Clear search text"
            class="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-apple-gray/30 text-app-secondary-label transition-colors hover:bg-apple-gray/45 hover:text-app-label"
          >
            <svg
              class="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        {/if}
      </div>
    {:else}
      <!-- Floating search button -->
      <button
        type="button"
        onclick={openSearch}
        aria-label="Open search"
        class="ml-auto flex size-12 shrink-0 items-center justify-center rounded-full border border-apple-gray/35 bg-app-surface/90 text-app-label shadow-lg backdrop-blur-xl transition-transform active:scale-95"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="size-7"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M10.5 3.75a6.75 6.75 0 1 0 0 13.5 6.75 6.75 0 0 0 0-13.5ZM2.25 10.5a8.25 8.25 0 1 1 14.59 5.28l4.69 4.69a.75.75 0 1 1-1.06 1.06l-4.69-4.69A8.25 8.25 0 0 1 2.25 10.5Z"
            clip-rule="evenodd"
          />
        </svg>
      </button>
    {/if}
  </div>
</div>

<MediaDetailsSheet
  item={selectedItem}
  bind:open={detailsOpen}
  bind:activeSnapPoint={detailsSnapPoint}
  {onPlay}
/>

<style>
  .texture-fade {
    pointer-events: none;
    position: absolute;
    inset: auto 0 0;
    height: 62%;
    background: linear-gradient(
      to bottom,
      transparent 5%,
      rgb(0 0 0 / 0.28) 48%,
      #000 100%
    );
  }

  .no-scrollbar {
    -ms-overflow-style: none;
    scrollbar-width: none;
  }

  .no-scrollbar::-webkit-scrollbar {
    display: none;
    height: 0;
    width: 0;
  }
</style>
