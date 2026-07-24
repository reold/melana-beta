<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import ContourTexture from "$lib/assets/contour-texture.png";
  import Dropdown from "$lib/common/Dropdown.svelte";
  import TagsSelect from "$lib/common/TagSelect.svelte";
  import VirtualPosterGrid from "$lib/browse/VirtualPosterGrid.svelte";
  import { CatalogState } from "$lib/catalog/catalog-state.svelte";
  import type { BrowseSort, MediaSummary, MediaType } from "$lib/tmdb/types";

  interface Props {
    onSelect?: (item: MediaSummary) => void;
  }

  let { onSelect = () => {} }: Props = $props();

  const sortOptions = ["Popularity", "Rating", "Date"] as const;
  const tagOptions = ["TV Shows", "Movies"] as const;
  const tagToMediaType: Record<(typeof tagOptions)[number], MediaType> = {
    "TV Shows": "tv",
    Movies: "movie",
  };
  const sortToBrowseSort: Record<(typeof sortOptions)[number], BrowseSort> = {
    Popularity: "popularity",
    Rating: "rating",
    Date: "newest",
  };

  const catalog = new CatalogState();
  let sortBy = $state<(typeof sortOptions)[number]>("Popularity");
  let includeTypes = $state<string[]>(["TV Shows", "Movies"]);
  let searchQuery = $state("");
  let searchInput = $state<HTMLInputElement | null>(null);
  let searchFocused = $state(false);
  let keyboardInset = $state(0);

  const isSearchMode = $derived(searchQuery.trim().length > 0);
  const selectedMediaTypes = $derived(
    includeTypes
      .filter(
        (tag): tag is (typeof tagOptions)[number] => tag in tagToMediaType,
      )
      .map((tag) => tagToMediaType[tag]),
  );

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

  function handleSearchFocus() {
    searchFocused = true;
    requestAnimationFrame(updateKeyboardInset);
  }

  function handleSearchBlur() {
    searchFocused = false;
    keyboardInset = 0;
  }

  function clearSearch() {
    searchQuery = "";
    searchInput?.focus();
  }
</script>

{#snippet sortIcon()}
  <svg
    class="h-5 w-5 shrink-0"
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

<div class="min-h-screen bg-app-canvas text-app-label">
  <header class="relative overflow-hidden px-5 pb-5 pt-14">
    <div
      class="pointer-events-none absolute inset-0 bg-cover bg-center opacity-25"
      style="background-image: url({ContourTexture});"
    ></div>
    <div class="texture-fade" aria-hidden="true"></div>
    <h1
      class="relative z-10 text-6xl font-extrabold leading-none tracking-tight"
    >
      Browse
    </h1>
  </header>

  <div
    class="no-scrollbar relative z-20 flex items-center gap-4 overflow-x-auto border-y border-app-separator bg-apple-white/[0.02] px-5 py-3"
    aria-label="Browse filters"
  >
    {#if !isSearchMode}
      <Dropdown
        options={[...sortOptions]}
        bind:value={sortBy}
        triggerIcon={sortIcon}
      />
    {/if}

    <TagsSelect
      options={[...tagOptions]}
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
    {onSelect}
  />

  <div
    class="fixed inset-x-0 z-40 flex items-center gap-2 px-5 transition-transform duration-150"
    style={`bottom: calc(1.5rem + env(safe-area-inset-bottom)); transform: translateY(-${keyboardInset}px);`}
  >
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
    </div>

    <button
      type="button"
      onclick={clearSearch}
      aria-label="Clear search"
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
  </div>
</div>

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
