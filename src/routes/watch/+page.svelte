<script lang="ts">
  import { browser } from "$app/environment";
  import { afterNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { getStream, fastProxiedUrl, type StreamSource, type GetStreamResult } from "$lib/streaming/client";
  import { attachHls, type HlsAttachment, type HlsQuality, type HlsQualitySelection } from "$lib/streaming/hls";
  import Dropdown, { type DropdownOption } from "$lib/common/Dropdown.svelte";
  import { fetchMediaDetails, tmdbPosterUrl } from "$lib/tmdb/client";
  import type { MediaDetails, MediaSummary, MediaType } from "$lib/tmdb/types";
  import { parseSubtitles, type SubtitleCue } from "$lib/subtitles/parser";
  import {
    searchSubtitles,
    fetchSubtitleText,
    SUBTITLE_LANGUAGES,
    type OpenSubtitlesResult,
  } from "$lib/subtitles/opensubtitles";

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
  let hlsAttachment: HlsAttachment | null = null;
  let hlsQualities = $state<HlsQuality[]>([]);
  // Start pinned to the lowest rendition. Auto is available explicitly in the UI.
  let selectedQuality = $state<HlsQualitySelection>(0);

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
  // Subtitle system
  // -------------------------------------------------------------------------

  interface UnifiedTrack {
    id: string;
    label: string;
    source: "vidcore" | "opensubtitles";
    src: string;
    downloads?: number;
  }

  // Cues stored separately from tracks so mutations are reactive
  let cuesMap = $state<Record<string, SubtitleCue[]>>({});

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
      }))
      .filter((track) => {
        const key = `${track.label}\u0000${track.src}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  });

  let osLanguage = $state<string>("en");
  let osResults = $state<OpenSubtitlesResult[]>([]);
  let osSearching = $state(false);
  let osError = $state<string | null>(null);
  let osSelectedResult = $state<OpenSubtitlesResult | null>(null);
  let osTracks = $state<UnifiedTrack[]>([]);
  let osExpanded = $state(false);
  let osSearchController: AbortController | null = null;
  let osSearchRequestId = 0;

  function cancelOpenSubtitlesSearch() {
    osSearchRequestId += 1;
    osSearchController?.abort();
    osSearchController = null;
    osSearching = false;
  }

  const allTracks = $derived.by((): UnifiedTrack[] => {
    return [...vidcoreTracks, ...osTracks];
  });

  // Dropdown option lists (label ≠ value so the shared component can render
  // pretty names while the underlying state stays a code / id / number).
  const serverOptions = $derived.by((): DropdownOption[] =>
    (streamResult?.streams ?? []).map((s) => ({
      label: s.server.name,
      value: s.server.name,
      icon: s.result.tracks.length > 0 ? captionsIcon : undefined,
    })),
  );

  const seasonOptions = $derived.by((): DropdownOption[] => {
    if (seasons.length === 0) return [{ label: "S1", value: "1" }];
    return seasons.map((item) => ({
      label: item.name || `S${item.seasonNumber}`,
      value: String(item.seasonNumber),
    }));
  });

  const episodeOptions = $derived.by((): DropdownOption[] =>
    Array.from({ length: episodeCount }, (_, i) => i + 1).map((n) => ({
      label: `E${n}`,
      value: String(n),
    })),
  );

  const qualityOptions = $derived.by((): DropdownOption[] => [
    { label: "Auto", value: "auto" },
    ...hlsQualities.map((quality) => ({
      label: quality.label,
      value: String(quality.id),
    })),
  ]);

  const subtitleOptions = $derived.by((): DropdownOption[] => [
    { label: "Subtitles off", value: "" },
    ...allTracks.map((t) => ({
      label: `${t.label}${t.source === "opensubtitles" ? " (OS)" : ""}`,
      value: t.id,
    })),
  ]);

  const languageOptions = $derived.by((): DropdownOption[] =>
    SUBTITLE_LANGUAGES.map((l) => ({ label: l.label, value: l.code })),
  );

  const osResultOptions = $derived.by((): DropdownOption[] =>
    osResults.map((r) => ({
      label: `${truncateMiddle(r.release, 64)} (${r.downloads.toLocaleString()} ↓)`,
      value: r.id,
    })),
  );

  let selectedTrackId = $state<string | null>(null);
  let subtitleDelay = $state(0);

  const selectedTrack = $derived(
    allTracks.find((t) => t.id === selectedTrackId) ?? null,
  );

  // Read cues from the reactive map — this is what triggers overlay updates
  const activeCues = $derived(cuesMap[selectedTrackId ?? ""] ?? []);

  // Load subtitle file when a track is selected (lazy loading)
  $effect(() => {
    const track = selectedTrack;
    if (!track) return;
    // Skip if this track has already been fetched — even when it parsed to
    // zero cues or failed. Guarding on "loaded, any result" (rather than
    // "has cues") is what stops an endless refetch loop for files that come
    // back empty.
    if (cuesMap[track.id] !== undefined) return;

    const controller = new AbortController();

    const storeCues = (text: string) => {
      if (controller.signal.aborted) return;
      cuesMap[track.id] = parseSubtitles(text);
    };
    const markAttempted = () => {
      // Record a fetch was attempted so the effect doesn't hot-loop retrying.
      if (!controller.signal.aborted) cuesMap[track.id] ??= [];
    };

    if (track.source === "vidcore") {
      void fetch(track.src, { signal: controller.signal })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.text();
        })
        .then((text) => storeCues(text))
        .catch(markAttempted);
    } else if (track.source === "opensubtitles") {
      const fileId = Number(track.src);
      if (!Number.isSafeInteger(fileId) || fileId <= 0) {
        markAttempted();
        return;
      }
      void fetchSubtitleText(fileId, controller.signal)
        .then((text) => storeCues(text))
        .catch(markAttempted);
    }

    return () => controller.abort();
  });

  $effect(() => {
    void source;
    cancelOpenSubtitlesSearch();
    osResults = [];
    osTracks = [];
    osSelectedResult = null;
    osError = null;
    selectedTrackId = null;
    subtitleDelay = 0;
    cuesMap = {};

    return () => cancelOpenSubtitlesSearch();
  });

  // -------------------------------------------------------------------------
  // Subtitle injection into the player
  // -------------------------------------------------------------------------
  // Inject the selected subtitle file as a native text track on the <video>
  // element. Unlike the old DOM overlay this renders with the built-in player
  // controls (including fullscreen) and on lockscreen/Now Playing surfaces.
  let subtitleTextTrack: TextTrack | null = null;

  $effect(() => {
    const el = video;
    const cues = activeCues;
    if (!el) return;

    // Clear the previous injected track so cues never stack up.
    if (subtitleTextTrack) {
      try {
        while (subtitleTextTrack.cues && subtitleTextTrack.cues.length > 0) {
          subtitleTextTrack.removeCue(subtitleTextTrack.cues[0] as VTTCue);
        }
      } catch {}
      subtitleTextTrack.mode = "hidden";
      subtitleTextTrack = null;
    }

    if (!cues || cues.length === 0 || typeof VTTCue === "undefined") return;

    const track = el.addTextTrack(
      "subtitles",
      selectedTrack?.label ?? "Subtitles",
      "und",
    );
    subtitleTextTrack = track;
    track.mode = "showing";

    const shift = subtitleDelay || 0;
    for (const cue of cues) {
      try {
        track.addCue(
          new VTTCue(
            Math.max(0, cue.start + shift),
            Math.max(0, cue.end + shift),
            cue.text,
          ),
        );
      } catch {}
    }
  });

  // -------------------------------------------------------------------------
  // Media Session (Now Playing / lockscreen metadata)
  // -------------------------------------------------------------------------
  $effect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;

    const artwork: MediaImage[] = [];
    const backdrop = details?.backdropPath ?? null;
    const backdropUrl = backdrop
      ? tmdbPosterUrl(backdrop, "w780")
      : null;
    if (backdropUrl) {
      artwork.push({ src: backdropUrl, sizes: "780x440", type: "image/jpeg" });
    }
    const posterUrl = displayPoster;
    if (posterUrl) {
      artwork.push({ src: posterUrl, sizes: "500x750", type: "image/jpeg" });
    }

    const year = details?.releaseDate?.slice(0, 4);
    const artist =
      (details?.creators?.length ?? 0) > 0
        ? (details?.creators ?? []).join(", ")
        : (details?.genres?.length ?? 0) > 0
          ? (details?.genres ?? []).join(" · ")
          : (year || "Melana");

    try {
      session.metadata = new MediaMetadata({
        title: displayTitle,
        artist,
        album:
          mediaType === "tv"
            ? `Season ${season} · Episode ${episode}${year ? ` · ${year}` : ""}`
            : (year || "Melana"),
        artwork,
      });
    } catch {}

    // Wire up lock-screen / hardware transport controls.
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void video?.play().catch(() => {}),
      pause: () => video?.pause(),
      seekbackward: () => {
        if (video) video.currentTime = Math.max(0, video.currentTime - 10);
      },
      seekforward: () => {
        if (video) {
          video.currentTime = Math.min(video.duration || 0, video.currentTime + 10);
        }
      },
    };
    for (const action of Object.keys(handlers) as MediaSessionAction[]) {
      const handler = handlers[action];
      if (handler) {
        try {
          session.setActionHandler(action, handler);
        } catch {}
      }
    }

    return () => {
      try {
        for (const action of Object.keys(handlers) as MediaSessionAction[]) {
          session.setActionHandler(action, null);
        }
      } catch {}
    };
  });

  // Keep Now Playing seek position in sync with playback.
  $effect(() => {
    const el = video;
    if (!el || !("mediaSession" in navigator)) return;
    const target: HTMLVideoElement = el;

    function updatePosition() {
      if (!Number.isFinite(target.duration) || target.duration <= 0) return;
      try {
        navigator.mediaSession.setPositionState?.({
          duration: target.duration,
          playbackRate: target.playbackRate,
          position: target.currentTime,
        });
      } catch {}
    }

    el.addEventListener("timeupdate", updatePosition);
    el.addEventListener("durationchange", updatePosition);
    return () => {
      el.removeEventListener("timeupdate", updatePosition);
      el.removeEventListener("durationchange", updatePosition);
    };
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

    // A new source has a new rendition list; begin conservatively again.
    hlsQualities = [];
    selectedQuality = 0;
    const attachment = attachHls(el, src.url, src.noReferrer, {
      initialQuality: 0,
      onQualitiesChange: (qualities) => {
        hlsQualities = qualities;
      },
      onQualityChange: (quality) => {
        selectedQuality = quality;
      },
      onFatalError: (message) => {
        error = message;
      },
    });
    hlsAttachment = attachment;
    return () => {
      if (hlsAttachment === attachment) hlsAttachment = null;
      attachment?.destroy();
    };
  });

  // -------------------------------------------------------------------------
  // OpenSubtitles actions
  // -------------------------------------------------------------------------

  async function searchOpenSubtitles() {
    if (!mediaType || !validRequest || osSearching) return;

    const requestMediaType = mediaType;
    const requestId = idParam;
    const requestLanguage = osLanguage;
    const requestSeason = season;
    const requestEpisode = episode;
    const controller = new AbortController();
    const searchRequestId = ++osSearchRequestId;

    osSearchController = controller;
    osSearching = true;
    osError = null;
    osResults = [];
    osTracks = [];
    osSelectedResult = null;

    try {
      const results = await searchSubtitles(
        requestId,
        requestLanguage,
        requestMediaType,
        requestMediaType === "tv" ? requestSeason : undefined,
        requestMediaType === "tv" ? requestEpisode : undefined,
        controller.signal,
      );

      if (controller.signal.aborted || searchRequestId !== osSearchRequestId) return;
      osResults = results;

      if (results.length > 0) {
        selectOsResult(results[0]);
      }
    } catch (reason: unknown) {
      if (!controller.signal.aborted && searchRequestId === osSearchRequestId) {
        osError = reason instanceof Error ? reason.message : "Search failed.";
      }
    } finally {
      if (searchRequestId === osSearchRequestId) {
        osSearchController = null;
        osSearching = false;
      }
    }
  }

  /** Truncate a long string from the middle with an ellipsis (macOS-style). */
  function truncateMiddle(value: string, maxLength: number): string {
    if (value.length <= maxLength) return value;
    const keep = Math.max(1, maxLength - 1); // reserve room for the ellipsis
    const left = Math.ceil(keep / 2);
    const right = Math.floor(keep / 2);
    return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
  }

  function selectOsResult(result: OpenSubtitlesResult) {
    osSelectedResult = result;
    const bestFile = result.files.reduce((best, f) =>
      f.downloads > best.downloads ? f : best,
    );

    const langLabel =
      SUBTITLE_LANGUAGES.find((l) => l.code === result.language)?.label ?? result.language;

    osTracks = result.files.map((file) => ({
      id: `os-${result.id}-${file.id}`,
      label: `${langLabel} · ${truncateMiddle(file.fileName, 48)}${result.files.length > 1 ? ` (${file.downloads.toLocaleString()} ↓)` : ""}`,
      source: "opensubtitles" as const,
      src: String(file.id),
      downloads: file.downloads,
    }));

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

  function selectQuality(value: string) {
    const quality: HlsQualitySelection = value === "auto" ? "auto" : Number(value);
    if (quality !== "auto" && (!Number.isInteger(quality) || quality < 0)) return;
    selectedQuality = quality;
    hlsAttachment?.setQuality(quality);
  }

  function selectSeason(value: number) {
    season = value;
    episode = 1;
  }

  // Stepping back through history (instead of pushing a fresh /browse entry)
  // is what lets Browse restore the exact list, sheet and scroll the user left.
  // Only safe when we know the previous entry is Browse.
  let cameFromBrowse = $state(false);
  afterNavigate((navigation) => {
    cameFromBrowse = navigation.from?.route.id === "/browse";
  });

  function leaveWatch() {
    if (cameFromBrowse) {
      history.back();
      return;
    }
    void goto(resolve("/browse"));
  }
</script>

{#snippet captionsIcon()}
  <svg
    class="h-3.5 w-3.5 shrink-0 text-app-secondary-label"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
    stroke-width="1.5"
    stroke="currentColor"
    aria-hidden="true"
  >
    <path
      stroke-linecap="round"
      stroke-linejoin="round"
      d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"
    />
  </svg>
{/snippet}

<svelte:head>
  <title>{displayTitle} - Melana</title>
</svelte:head>

<main class="min-h-screen bg-app-canvas pb-10 pt-[calc(env(safe-area-inset-top)+1rem)] text-app-label">
  <div class="px-4 sm:px-8">
    <div class="mx-auto max-w-6xl">
      <button
        type="button"
        class="mb-5 inline-flex items-center rounded-lg p-2 text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
        onclick={leaveWatch}
        aria-label="Back to browse"
      >
        <svg class="h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
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
    <!-- Full-width video player -->
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
        {/if}
      </div>
    </div>

    <!-- Controls below player -->
    <div class="px-4 sm:px-8">
      <div class="mx-auto max-w-6xl">

        <!-- Title row -->
        <div class="mt-5 flex flex-wrap items-center gap-2">
          <h1 class="text-2xl font-extrabold tracking-tight">{displayTitle}</h1>
          {#if source?.is4k}
            <span class="rounded-md bg-apple-green/15 px-2 py-0.5 text-xs font-bold uppercase tracking-wide text-apple-green">4K</span>
          {/if}
        </div>

        <!-- Playback section -->
        {#if streamResult && streamResult.streams.length > 0}
          <div class="mt-4 rounded-2xl border border-app-separator bg-app-surface p-4">
            <div class="flex flex-wrap items-center gap-3">
              <!-- Server -->
              <div class="flex items-center gap-2">
                <svg class="h-4 w-4 shrink-0 text-app-secondary-label" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z" />
                </svg>
                <Dropdown
                  options={serverOptions}
                  value={selectedServerName}
                  onChange={(name) => (selectedServerName = name)}
                />
              </div>

              <!-- Quality: pinned low by default; Auto is an explicit choice. -->
              {#if hlsQualities.length > 0}
                <span class="h-5 w-px bg-app-separator" aria-hidden="true"></span>
                <div class="flex items-center gap-2">
                  <svg class="h-4 w-4 shrink-0 text-app-secondary-label" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5" />
                  </svg>
                  <Dropdown
                    label="Quality"
                    options={qualityOptions}
                    value={selectedQuality === "auto" ? "auto" : String(selectedQuality)}
                    onChange={selectQuality}
                  />
                </div>
              {/if}

              <!-- Season / Episode (TV only) -->
              {#if mediaType === "tv"}
                <span class="h-5 w-px bg-app-separator" aria-hidden="true"></span>

                <Dropdown
                  options={seasonOptions}
                  value={String(season)}
                  onChange={(v) => selectSeason(Number(v))}
                />

                <Dropdown
                  options={episodeOptions}
                  value={String(episode)}
                  onChange={(v) => (episode = Number(v))}
                />

                {#if detailsLoading}
                  <span class="text-xs text-app-secondary-label">Loading…</span>
                {/if}
              {/if}
            </div>
          </div>
        {/if}

        <!-- Subtitles section -->
        <div class="mt-3 rounded-2xl border border-app-separator bg-app-surface p-4">
          <!-- Subtitle dropdown + delay row -->
          <div class="flex flex-wrap items-center gap-3">
            <div class="flex items-center gap-2">
              <!-- Subtitles icon -->
              <svg class="h-4 w-4 shrink-0 text-app-secondary-label" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z" />
              </svg>
              <Dropdown
                options={subtitleOptions}
                value={selectedTrackId ?? ""}
                onChange={(v) => (selectedTrackId = v || null)}
                triggerLabelClass="max-w-[16rem]"
              />
            </div>

            <!-- Delay controls (shown when subtitle active) -->
            {#if selectedTrack}
              <span class="h-5 w-px bg-app-separator" aria-hidden="true"></span>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-md border border-app-separator bg-app-surface text-app-secondary-label hover:bg-app-surface-hover hover:text-app-label"
                  onclick={() => adjustDelay(-0.25)}
                  aria-label="Subtitles 0.25s earlier"
                >
                  <svg class="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="min-w-[4rem] rounded-md border border-app-separator bg-app-surface px-2 py-1 text-center text-xs font-semibold tabular-nums text-app-secondary-label hover:text-app-label"
                  onclick={resetDelay}
                  title="Click to reset"
                >{formatDelay(subtitleDelay)}</button>
                <button
                  type="button"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-md border border-app-separator bg-app-surface text-app-secondary-label hover:bg-app-surface-hover hover:text-app-label"
                  onclick={() => adjustDelay(0.25)}
                  aria-label="Subtitles 0.25s later"
                >
                  <svg class="h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" aria-hidden="true">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                  </svg>
                </button>
              </div>
            {/if}
          </div>

          <!-- OpenSubtitles collapsible -->
          <div class="mt-3">
            <button
              type="button"
              class="inline-flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm font-semibold text-app-secondary-label hover:bg-apple-white/5 hover:text-app-label"
              onclick={() => { osExpanded = !osExpanded; }}
            >
              <svg class="h-4 w-4 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418" />
              </svg>
              <span>OpenSubtitles</span>
              {#if osTracks.length > 0}
                <span class="rounded-full bg-apple-green/15 px-1.5 py-0.5 text-[10px] font-bold text-apple-green">{osTracks.length}</span>
              {/if}
              <svg
                class="ml-auto h-4 w-4 shrink-0 transition-transform duration-200"
                class:rotate-180={osExpanded}
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="2"
                stroke="currentColor"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
              </svg>
            </button>

            {#if osExpanded}
              <div class="mt-2 space-y-3 border-t border-app-separator pt-3">
                <div class="flex flex-wrap items-center gap-3">
                  <Dropdown
                    options={languageOptions}
                    value={osLanguage}
                    onChange={(code) => (osLanguage = code)}
                  />

                  <button
                    type="button"
                    class="inline-flex items-center gap-2 rounded-[10px] border border-apple-blue/40 bg-apple-blue/15 px-3 py-1 text-sm font-semibold text-apple-blue transition-colors hover:bg-apple-blue/25 disabled:opacity-50"
                    onclick={searchOpenSubtitles}
                    disabled={osSearching}
                  >
                    {#if osSearching}
                      <span class="h-4 w-4 animate-spin rounded-full border-2 border-apple-blue border-t-transparent"></span>
                    {/if}
                    {osSearching ? "Searching…" : "Search"}
                  </button>
                </div>

                {#if osError}
                  <p class="text-sm text-apple-red">{osError}</p>
                {/if}

                {#if osResults.length > 1}
                  <Dropdown
                    options={osResultOptions}
                    value={osSelectedResult?.id ?? ""}
                    onChange={(id) => {
                      const result = osResults.find((r) => r.id === id);
                      if (result) selectOsResult(result);
                    }}
                    stretch
                    triggerLabelClass="max-w-full"
                  />
                {:else if osResults.length === 1}
                  <p class="text-xs text-app-secondary-label">
                    {osResults[0].release} · {osResults[0].downloads.toLocaleString()} downloads
                  </p>
                {:else if !osSearching && !osError && osTracks.length === 0}
                  <p class="text-xs text-app-secondary-label">No results yet. Pick a language and search.</p>
                {/if}
              </div>
            {/if}
          </div>
        </div>

      </div>
    </div>
  {/if}
</main>
