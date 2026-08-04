<script lang="ts">
  import { browser } from "$app/environment";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { getStream, fastProxiedUrl, type StreamSource, type GetStreamResult } from "$lib/streaming/client";
  import { attachHls } from "$lib/streaming/hls";
  import { fetchMediaDetails, tmdbPosterUrl } from "$lib/tmdb/client";
  import type { MediaDetails, MediaSummary, MediaType } from "$lib/tmdb/types";
  import Dropdown from "$lib/common/Dropdown.svelte";

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
  let streamResult = $state<GetStreamResult | null>(null);
  let selectedServerName = $state<string>("");

  const source = $derived.by(() => {
    if (!streamResult || !selectedServerName) return null;
    const item = streamResult.streams.find((s) => s.server.name === selectedServerName);
    return item ? item.result : (streamResult.streams[0]?.result ?? null);
  });

  let selectedSubtitleIndex = $state<number | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let subtitleTrackElement = $state<HTMLTrackElement | null>(null);

  const seasons = $derived(
    (details?.seasons ?? []).filter((item) => item.seasonNumber > 0),
  );
  const selectedSeason = $derived(seasons.find((item) => item.seasonNumber === season));
  const episodeCount = $derived(selectedSeason?.episodeCount ?? 1);
  const displayTitle = $derived(details?.title ?? titleParam);
  const displayPoster = $derived(
    details ? tmdbPosterUrl(details.posterPath, "w500") : tmdbPosterUrl(posterPath, "w500"),
  );

  // VidCore/Vidfast can return a very large list of sidecar subtitle files.
  // Native <video> eagerly fetches every rendered <track> child in some browsers
  // (notably Firefox), so keep the catalogue in JS but render no subtitle track
  // until the user explicitly chooses one.
  const subtitleTracks = $derived.by(() => {
    const current = source;
    if (!current) return [];

    const seen = new Set<string>();
    return current.tracks
      .map((track, sourceIndex) => ({
        // Subtitles are small but benefit from fast edge proxy as well
        src: fastProxiedUrl(track.file, current.noReferrer),
        label: track.label,
        srclang: languageCode(track.label),
        sourceIndex,
      }))
      .filter((track) => {
        const key = `${track.label}\u0000${track.src}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });
  const selectedSubtitleTrack = $derived(
    selectedSubtitleIndex === null
      ? null
      : (subtitleTracks.find((track) => track.sourceIndex === selectedSubtitleIndex) ?? null),
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
    streamResult = null;
    selectedServerName = "";
    selectedSubtitleIndex = null;

    void getStream(mediaType, idParam, season, episode, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        streamResult = result;
        if (result.streams.length > 0) {
          selectedServerName = result.streams[0].server.name;
        } else {
          selectedServerName = "";
        }
        selectedSubtitleIndex = null;
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

  // Attach the VidCore HLS playlist to the <video> element whenever a new source
  // resolves. hls.js handles every modern browser — including Safari on
  // macOS/iPadOS and iPhone/iPad on iOS 17.1+, which expose (Managed) Media
  // Source. The stream proxy rewrites the manifest (variants, segments, keys,
  // subtitles) to the fast edge proxy server-side, so hls.js runs with its
  // default loader and the legacy native HLS path can play the proxied
  // playlist directly.
  $effect(() => {
    const el = video;
    const src = source;
    if (!el || !src) return;

    const attachment = attachHls(el, src.url, src.noReferrer);
    return () => {
      attachment?.destroy();
    };
  });

  // When a subtitle is selected, force its TextTrack into the visible state.
  // This makes the custom selector work even though the browser's native track
  // menu initially has no rendered tracks.
  $effect(() => {
    const track = subtitleTrackElement;
    if (!track || !selectedSubtitleTrack) return;
    track.track.mode = "showing";
  });

  function selectSeason(value: number) {
    season = value;
    episode = 1;
  }

  // VidCore hands back human-readable track labels ("English", "zh-tw", …).
  // Derive a stable, unique BCP-47-ish token so each <track> gets an srclang;
  // the readable label is what the player actually displays.
  function languageCode(label: string): string {
    const code = label
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return code || "subtitle";
  }
</script>

<svelte:head>
  <title>{displayTitle} - Melana</title>
</svelte:head>

<main class="min-h-screen bg-app-canvas pb-10 pt-[calc(env(safe-area-inset-top)+1rem)] text-app-label">
  <div class="px-4 sm:px-8">
    <div class="mx-auto max-w-6xl">
      <button
        type="button"
        class="mb-5 inline-flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-bold text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
        onclick={() => goto(resolve("/browse"))}
      >
        <span aria-hidden="true">←</span> Back to browse
      </button>
    </div>
  </div>

  {#if !validRequest}
    <div class="px-4 sm:px-8">
      <div class="mx-auto max-w-6xl">
        <section class="rounded-2xl border border-apple-red/50 bg-apple-red/10 p-6">
          <h1 class="text-xl font-bold">Invalid watch link</h1>
          <p class="mt-2 text-app-secondary-label">Choose a title from Browse and press Play to start watching.</p>
        </section>
      </div>
    </div>
  {:else}
    <div class="bg-black">
      <div class="aspect-video w-full bg-app-surface">
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
        {:else if source}
          <video
            bind:this={video}
            class="h-full w-full bg-black"
            controls
            playsinline
            crossorigin="anonymous"
            preload="auto"
            poster={displayPoster ?? undefined}
            aria-label={`Watch ${displayTitle}`}
          >
            {#if selectedSubtitleTrack}
              {#key selectedSubtitleTrack.src}
                <track
                  bind:this={subtitleTrackElement}
                  kind="subtitles"
                  src={selectedSubtitleTrack.src}
                  srclang={selectedSubtitleTrack.srclang}
                  label={selectedSubtitleTrack.label}
                  default
                />
              {/key}
            {/if}
            Your browser does not support HTML5 video.
          </video>
        {/if}
      </div>
    </div>

    <div class="px-4 sm:px-8">
      <div class="mx-auto max-w-6xl">
        <div class="mt-5 flex flex-col gap-5 sm:flex-row sm:items-start">
          {#if displayPoster}
            <img src={displayPoster} alt="" class="hidden w-28 rounded-xl object-cover sm:block" />
          {/if}
          <section class="min-w-0 flex-1">
            <p class="text-xs font-bold uppercase tracking-[0.16em] text-apple-green">{mediaType === "tv" ? "TV show" : "Movie"}</p>
            <div class="mt-1 flex flex-wrap items-center gap-2">
              <h1 class="text-3xl font-extrabold tracking-tight">{displayTitle}</h1>
              {#if source?.is4k}
                <span class="rounded-md bg-apple-green/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-apple-green">4K</span>
              {/if}
            </div>

            {#if streamResult && streamResult.streams.length > 0}
              <div class="mt-5 flex flex-wrap items-center gap-4">
                <Dropdown
                  label="Server"
                  options={streamResult.streams.map((s) => s.server.name)}
                  bind:value={selectedServerName}
                  onChange={() => {
                    selectedSubtitleIndex = null;
                  }}
                />
              </div>
            {/if}

            {#if subtitleTracks.length}
              <label class="mt-5 grid max-w-sm gap-1.5 text-sm font-semibold">
                Subtitles
                <select
                  value={selectedSubtitleIndex ?? ""}
                  onchange={(event) => {
                    const value = event.currentTarget.value;
                    selectedSubtitleIndex = value ? Number(value) : null;
                  }}
                  class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green"
                >
                  <option value="">Off</option>
                  {#each subtitleTracks as track (track.sourceIndex)}
                    <option value={track.sourceIndex}>{track.label}</option>
                  {/each}
                </select>
              </label>
            {/if}

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
          </section>
        </div>
      </div>
    </div>
  {/if}
</main>
