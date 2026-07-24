<script lang="ts">
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { getStream, type StreamQuality } from "$lib/streaming/client";
  import { fetchMediaDetails, tmdbPosterUrl } from "$lib/tmdb/client";
  import type { MediaDetails, MediaSummary, MediaType } from "$lib/tmdb/types";

  // Query parameters are read only in the browser because this static route is
  // prerendered at build time, when SvelteKit deliberately disallows page.url.
  const searchParams = $derived(browser ? page.url.searchParams : new URLSearchParams());
  const typeParam = $derived(searchParams.get("type"));
  const idParam = $derived(Number(searchParams.get("id")));
  const titleParam = $derived(searchParams.get("title")?.trim() || "Untitled");
  const posterPath = $derived(searchParams.get("poster"));
  const mediaType = $derived<MediaType | null>(
    typeParam === "movie" || typeParam === "tv" ? typeParam : null,
  );
  const validRequest = $derived(Boolean(mediaType && Number.isSafeInteger(idParam) && idParam > 0));

  let details = $state<MediaDetails | null>(null);
  let detailsLoading = $state(false);
  let season = $state(1);
  let episode = $state(1);
  let qualities = $state<StreamQuality[]>([]);
  let selectedQuality = $state("");
  let loading = $state(false);
  let error = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);

  const selectedSource = $derived(
    qualities.find((quality) => quality.label === selectedQuality) ?? qualities[0] ?? null,
  );
  const seasons = $derived(
    (details?.seasons ?? []).filter((item) => item.seasonNumber > 0),
  );
  const selectedSeason = $derived(seasons.find((item) => item.seasonNumber === season));
  const episodeCount = $derived(selectedSeason?.episodeCount ?? 1);
  const displayTitle = $derived(details?.title ?? titleParam);
  const displayPoster = $derived(
    details ? tmdbPosterUrl(details.posterPath, "w500") : tmdbPosterUrl(posterPath, "w500"),
  );

  function mediaSummary(): MediaSummary | null {
    if (!mediaType || !validRequest) return null;
    return {
      id: idParam,
      mediaType,
      title: titleParam,
      posterPath,
      backdropPath: null,
      releaseDate: null,
      rating: null,
      voteCount: null,
      popularity: null,
      overview: "",
    };
  }

  // Fetch title metadata only to populate the TV season/episode chooser. Video
  // resolution itself always comes from the user's stream proxy.
  $effect(() => {
    const media = mediaSummary();
    if (!media || media.mediaType !== "tv") {
      details = null;
      return;
    }

    const controller = new AbortController();
    detailsLoading = true;
    void fetchMediaDetails(media, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        details = result;
        const firstSeason = result.seasons.find((item) => item.seasonNumber > 0);
        if (firstSeason) season = firstSeason.seasonNumber;
      })
      .catch(() => {
        // The default S01E01 remains usable even if TMDB metadata is unavailable.
        details = null;
      })
      .finally(() => {
        if (!controller.signal.aborted) detailsLoading = false;
      });

    return () => controller.abort();
  });

  // Resolve a fresh signed stream when the requested title or TV episode changes.
  $effect(() => {
    if (!mediaType || !validRequest) return;
    const controller = new AbortController();
    loading = true;
    error = null;
    qualities = [];
    selectedQuality = "";

    void getStream(mediaType, idParam, season, episode, controller.signal)
      .then((sources) => {
        if (controller.signal.aborted) return;
        qualities = sources;
        selectedQuality = sources[0].label;
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          error = reason instanceof Error ? reason.message : "Could not load this stream.";
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });

    return () => controller.abort();
  });

  function selectSeason(value: number) {
    season = value;
    episode = 1;
  }

  function selectQuality(value: string) {
    selectedQuality = value;
    // Changing a <video> source requires a new load; play is intentionally not
    // forced because browsers require it to originate from a user gesture.
    requestAnimationFrame(() => video?.load());
  }
</script>

<svelte:head>
  <title>{displayTitle} · Watch · Melana</title>
</svelte:head>

<main class="min-h-screen bg-app-canvas px-4 pb-10 pt-[calc(env(safe-area-inset-top)+1rem)] text-app-label sm:px-8">
  <div class="mx-auto max-w-6xl">
    <button
      type="button"
      class="mb-5 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-bold text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
      onclick={() => goto("/browse")}
    >
      <span aria-hidden="true">←</span> Back to browse
    </button>

    {#if !validRequest}
      <section class="rounded-2xl border border-apple-red/50 bg-apple-red/10 p-6">
        <h1 class="text-xl font-bold">Invalid watch link</h1>
        <p class="mt-2 text-app-secondary-label">Choose a title from Browse and press Play to start watching.</p>
      </section>
    {:else}
      <div class="overflow-hidden rounded-2xl border border-app-separator bg-black shadow-2xl">
        <div class="aspect-video bg-app-surface">
          {#if loading}
            <div class="flex h-full items-center justify-center gap-3 text-app-secondary-label" aria-live="polite">
              <span class="h-5 w-5 animate-spin rounded-full border-2 border-app-secondary-label border-t-transparent"></span>
              Finding a stream…
            </div>
          {:else if error}
            <div class="flex h-full flex-col items-center justify-center px-6 text-center">
              <p class="font-bold text-apple-red">Unable to load video</p>
              <p class="mt-2 max-w-md text-sm text-app-secondary-label">{error}</p>
            </div>
          {:else if selectedSource}
            <video
              bind:this={video}
              class="h-full w-full bg-black"
              controls
              playsinline
              poster={displayPoster ?? undefined}
              aria-label={`Watch ${displayTitle}`}
            >
              <source src={selectedSource.url} type={selectedSource.type === "mp4" ? "video/mp4" : selectedSource.type} />
              Your browser does not support HTML5 video.
            </video>
          {/if}
        </div>
      </div>

      <div class="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
        {#if displayPoster}
          <img src={displayPoster} alt="" class="hidden w-28 rounded-xl object-cover sm:block" />
        {/if}
        <section class="min-w-0 flex-1">
          <p class="text-xs font-bold uppercase tracking-[0.16em] text-apple-green">{mediaType === "tv" ? "TV show" : "Movie"}</p>
          <h1 class="mt-1 text-3xl font-extrabold tracking-tight">{displayTitle}</h1>

          {#if mediaType === "tv"}
            <div class="mt-5 grid gap-3 sm:grid-cols-2">
              <label class="grid gap-1.5 text-sm font-semibold">
                Season
                <select value={season} onchange={(event) => selectSeason(Number(event.currentTarget.value))} class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green">
                  {#if seasons.length}
                    {#each seasons as item (item.seasonNumber)}
                      <option value={item.seasonNumber}>{item.name || `Season ${item.seasonNumber}`}</option>
                    {/each}
                  {:else}
                    <option value="1">Season 1</option>
                  {/if}
                </select>
              </label>
              <label class="grid gap-1.5 text-sm font-semibold">
                Episode
                <select value={episode} onchange={(event) => (episode = Number(event.currentTarget.value))} class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green">
                  {#each Array.from({ length: episodeCount }, (_, index) => index + 1) as number}
                    <option value={number}>Episode {number}</option>
                  {/each}
                </select>
              </label>
            </div>
            {#if detailsLoading}<p class="mt-2 text-xs text-app-secondary-label">Loading episode information…</p>{/if}
          {/if}

          {#if qualities.length > 1}
            <label class="mt-5 grid max-w-xs gap-1.5 text-sm font-semibold">
              Quality
              <select value={selectedQuality} onchange={(event) => selectQuality(event.currentTarget.value)} class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green">
                {#each qualities as quality (quality.label)}
                  <option value={quality.label}>{quality.label}p{quality.codecName ? ` · ${quality.codecName}` : ""}</option>
                {/each}
              </select>
            </label>
          {/if}
        </section>
      </div>
    {/if}
  </div>
</main>
