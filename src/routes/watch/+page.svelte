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
  import SubtitleOverlay from "$lib/subtitles/SubtitleOverlay.svelte";
  import { parseSubtitles, type SubtitleCue } from "$lib/subtitles/parser";
  import {
    searchSubtitles,
    fetchSubtitleText,
    isOpenSubtitlesConfigured,
    SUBTITLE_LANGUAGES,
    type OpenSubtitlesResult,
    type OpenSubtitlesFile,
  } from "$lib/subtitles/opensubtitles";

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

  let loading = $state(false);
  let error = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);

  const seasons = $derived(
    (details?.seasons ?? []).filter((item) => item.seasonNumber > 0),
  );
  const selectedSeason = $derived(seasons.find((item) => item.seasonNumber === season));
  const episodeCount = $derived(selectedSeason?.episodeCount ?? 1);
  const displayTitle = $derived(details?.title ?? titleParam);
  const displayPoster = $derived(
    details ? tmdbPosterUrl(details.posterPath, "w500") : tmdbPosterUrl(posterPath, "w500"),
  );

  // -------------------------------------------------------------------------
  // Subtitle system (unified: VidCore + OpenSubtitles)
  // -------------------------------------------------------------------------

  interface UnifiedTrack {
    id: string;
    label: string;
    source: "vidcore" | "opensubtitles";
    /** For VidCore: proxied URL. For OpenSubtitles: file id (loaded on demand). */
    src: string;
    /** Populated after the subtitle file is fetched and parsed. */
    cues: SubtitleCue[];
    downloads?: number;
  }

  // VidCore tracks from the stream provider
  const vidcoreTracks = $derived.by((): UnifiedTrack[] => {
    const current = source;
    if (!current) return [];
    const seen = new Set<string>();
    return current.tracks
      .map((track, index) => ({
        id: `vidcore-${index}`,
        label: track.label,
        source: "vidcore" as const,
        src: fastProxiedUrl(track.file, current.noReferrer),
        cues: [] as SubtitleCue[],
      }))
      .filter((track) => {
        const key = `${track.label}\u0000${track.src}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });

  // OpenSubtitles state
  let osLanguage = $state<string>("en");
  let osResults = $state<OpenSubtitlesResult[]>([]);
  let osSearching = $state(false);
  let osError = $state<string | null>(null);
  let osSelectedResult = $state<OpenSubtitlesResult | null>(null);
  let osTracks = $state<UnifiedTrack[]>([]);

  // Combined track list: VidCore first, then OpenSubtitles
  const allTracks = $derived.by((): UnifiedTrack[] => {
    return [...vidcoreTracks, ...osTracks];
  });

  let selectedTrackId = $state<string | null>(null);
  let subtitleDelay = $state(0);

  const selectedTrack = $derived(
    allTracks.find((t) => t.id === selectedTrackId) ?? null,
  );

  const activeCues = $derived(selectedTrack?.cues ?? []);

  // Load subtitle file when a track is selected (lazy loading)
  $effect(() => {
    const track = selectedTrack;
    if (!track || track.cues.length > 0) return;

    const controller = new AbortController();

    if (track.source === "vidcore") {
      // Fetch from the proxied URL
      void fetch(track.src, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => {
          if (controller.signal.aborted) return;
          track.cues = parseSubtitles(text);
        })
        .catch(() => {
          // Silently fail — the track just won't show subtitles
        });
    } else if (track.source === "opensubtitles") {
      // src is the file id
      const fileId = Number(track.src);
      if (!Number.isFinite(fileId)) return;
      void fetchSubtitleText(fileId, controller.signal)
        .then((text) => {
          if (controller.signal.aborted) return;
          track.cues = parseSubtitles(text);
        })
        .catch(() => {
          // Silently fail
        });
    }

    return () => controller.abort();
  });

  // Reset OpenSubtitles when the stream source changes
  $effect(() => {
    // Touch source to track changes
    void source;
    osResults = [];
    osTracks = [];
    osSelectedResult = null;
    osError = null;
    selectedTrackId = null;
    subtitleDelay = 0;
  });

  // -------------------------------------------------------------------------
  // Stream loading
  // -------------------------------------------------------------------------

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
        details = null;
      })
      .finally(() => {
        if (!controller.signal.aborted) detailsLoading = false;
      });

    return () => controller.abort();
  });

  $effect(() => {
    if (!mediaType || !validRequest) return;
    const controller = new AbortController();
    loading = true;
    error = null;
    streamResult = null;
    selectedServerName = "";

    void getStream(mediaType, idParam, season, episode, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        streamResult = result;
        if (result.streams.length > 0) {
          selectedServerName = result.streams[0].server.name;
        } else {
          selectedServerName = "";
        }
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

  $effect(() => {
    const el = video;
    const src = source;
    if (!el || !src) return;

    const attachment = attachHls(el, src.url, src.noReferrer);
    return () => {
      attachment?.destroy();
    };
  });

  // -------------------------------------------------------------------------
  // OpenSubtitles actions
  // -------------------------------------------------------------------------

  async function searchOpenSubtitles() {
    if (!mediaType || !validRequest) return;
    const controller = new AbortController();
    osSearching = true;
    osError = null;
    osResults = [];
    osTracks = [];
    osSelectedResult = null;

    try {
      const results = await searchSubtitles(
        idParam,
        osLanguage,
        mediaType,
        mediaType === "tv" ? season : undefined,
        mediaType === "tv" ? episode : undefined,
        controller.signal,
      );
      osResults = results;

      // Auto-select the most downloaded result and load its best file
      if (results.length > 0) {
        selectOsResult(results[0]);
      }
    } catch (reason: unknown) {
      osError = reason instanceof Error ? reason.message : "Search failed.";
    } finally {
      osSearching = false;
    }
  }

  function selectOsResult(result: OpenSubtitlesResult) {
    osSelectedResult = result;
    // Pick the file with the most downloads
    const bestFile = result.files.reduce((best, f) =>
      f.downloads > best.downloads ? f : best,
    );

    const langLabel =
      SUBTITLE_LANGUAGES.find((l) => l.code === result.language)?.label ?? result.language;

    // Create a unified track for each file in the result
    osTracks = result.files.map((file, index) => ({
      id: `os-${result.id}-${file.id}`,
      label: `${langLabel} · ${file.fileName}${result.files.length > 1 ? ` (${file.downloads.toLocaleString()} ↓)` : ""}`,
      source: "opensubtitles" as const,
      src: String(file.id),
      cues: [] as SubtitleCue[],
      downloads: file.downloads,
    }));

    // Auto-select the best file
    if (osTracks.length > 0) {
      const bestTrack = osTracks.find((t) => t.src === String(bestFile.id)) ?? osTracks[0];
      selectedTrackId = bestTrack.id;
    }
  }

  // -------------------------------------------------------------------------
  // Delay controls
  // -------------------------------------------------------------------------

  function adjustDelay(delta: number) {
    subtitleDelay = Math.round((subtitleDelay + delta) * 100) / 100;
  }

  function resetDelay() {
    subtitleDelay = 0;
  }

  function formatDelay(seconds: number): string {
    const sign = seconds >= 0 ? "+" : "";
    return `${sign}${seconds.toFixed(2)}s`;
  }

  function selectSeason(value: number) {
    season = value;
    episode = 1;
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
        class="mb-5 inline-flex items-center rounded-lg p-2 text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
        onclick={() => goto(resolve("/browse"))}
        aria-label="Back to browse"
      >
        <svg
          class="h-6 w-6"
          xmlns="http://www.w3.org/2000/svg"
          fill="none"
          viewBox="0 0 24 24"
          stroke-width="1.5"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
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
    <div class="relative bg-black">
      <div class="relative aspect-video w-full bg-app-surface">
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
            Your browser does not support HTML5 video.
          </video>
          <SubtitleOverlay
            {video}
            cues={activeCues}
            delay={subtitleDelay}
          />
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
                />
              </div>
            {/if}

            <!-- Subtitles section -->
            <div class="mt-5 space-y-3">
              <label class="grid max-w-sm gap-1.5 text-sm font-semibold">
                Subtitles
                <select
                  value={selectedTrackId ?? ""}
                  onchange={(event) => {
                    selectedTrackId = event.currentTarget.value || null;
                  }}
                  class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green"
                >
                  <option value="">Off</option>
                  {#each allTracks as track (track.id)}
                    <option value={track.id}>
                      {track.label}
                      {#if track.source === "opensubtitles"} (OpenSubtitles){/if}
                    </option>
                  {/each}
                </select>
              </label>

              <!-- Delay controls (shown when a subtitle is active) -->
              {#if selectedTrack}
                <div class="flex items-center gap-3 text-sm">
                  <span class="font-semibold text-app-secondary-label">Sync</span>
                  <button
                    type="button"
                    class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-app-separator bg-app-surface text-sm font-bold hover:bg-app-surface-hover"
                    onclick={() => adjustDelay(-0.25)}
                    aria-label="Subtitles 0.25s earlier"
                  >−</button>
                  <button
                    type="button"
                    class="min-w-[4.5rem] rounded-md border border-app-separator bg-app-surface px-2 py-1 text-center text-sm font-semibold tabular-nums"
                    onclick={resetDelay}
                    title="Click to reset"
                  >{formatDelay(subtitleDelay)}</button>
                  <button
                    type="button"
                    class="inline-flex h-8 w-8 items-center justify-center rounded-md border border-app-separator bg-app-surface text-sm font-bold hover:bg-app-surface-hover"
                    onclick={() => adjustDelay(0.25)}
                    aria-label="Subtitles 0.25s later"
                  >+</button>
                </div>
              {/if}

              <!-- OpenSubtitles search -->
              <div class="flex flex-wrap items-center gap-3">
                <select
                  bind:value={osLanguage}
                  class="rounded-lg border border-app-separator bg-app-surface px-3 py-2 text-sm font-medium outline-none focus:border-apple-green"
                  aria-label="Subtitle language"
                >
                  {#each SUBTITLE_LANGUAGES as lang}
                    <option value={lang.code}>{lang.label}</option>
                  {/each}
                </select>

                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-lg border border-app-separator bg-app-surface px-4 py-2 text-sm font-semibold transition-colors hover:bg-app-surface-hover disabled:opacity-50"
                  onclick={searchOpenSubtitles}
                  disabled={osSearching || !isOpenSubtitlesConfigured()}
                >
                  {#if osSearching}
                    <span class="h-4 w-4 animate-spin rounded-full border-2 border-app-secondary-label border-t-transparent"></span>
                  {:else}
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.35-4.35" />
                    </svg>
                  {/if}
                  {osSearching ? "Searching…" : "OpenSubtitles"}
                </button>

                {#if !isOpenSubtitlesConfigured()}
                  <span class="text-xs text-app-secondary-label">Set PUBLIC_OPENSUBTITLES_API_KEY to enable</span>
                {/if}
              </div>

              {#if osError}
                <p class="text-sm text-apple-red">{osError}</p>
              {/if}

              {#if osResults.length > 1}
                <label class="grid max-w-md gap-1.5 text-sm font-semibold">
                  <span class="text-app-secondary-label">
                    {osResults.length} results — switch release:
                  </span>
                  <select
                    value={osSelectedResult?.id ?? ""}
                    onchange={(event) => {
                      const result = osResults.find((r) => r.id === event.currentTarget.value);
                      if (result) selectOsResult(result);
                    }}
                    class="rounded-lg border border-app-separator bg-app-surface px-3 py-2.5 font-medium outline-none focus:border-apple-green"
                  >
                    {#each osResults as result (result.id)}
                      <option value={result.id}>
                        {result.release} ({result.downloads.toLocaleString()} ↓)
                      </option>
                    {/each}
                  </select>
                </label>
              {:else if osResults.length === 0 && !osSearching && !osError && osTracks.length === 0}
                <!-- No results yet — only show after a search has been attempted -->
              {/if}
            </div>

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
