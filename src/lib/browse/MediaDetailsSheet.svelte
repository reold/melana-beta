<script lang="ts">
  import Drawer from "@harshmandan/svaul";
  import { fetchMediaDetails, tmdbPosterUrl } from "$lib/tmdb/client";
  import type { MediaDetails, MediaSummary } from "$lib/tmdb/types";

  interface Props {
    item: MediaSummary | null;
    open?: boolean;
    onPlay?: (item: MediaDetails | MediaSummary) => void;
  }

  let { item, open = $bindable(false), onPlay = () => {} }: Props = $props();
  const compactSnapPoint = 0.58;
  const expandedSnapPoint = 0.94;

  let activeSnapPoint = $state<number | string>(compactSnapPoint);
  let details = $state<MediaDetails | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  const isExpanded = $derived(activeSnapPoint === expandedSnapPoint);

  $effect(() => {
    if (!open || !item) {
      details = null;
      loading = false;
      error = null;
      return;
    }

    const controller = new AbortController();
    const selectedKey = `${item.mediaType}:${item.id}`;
    loading = true;
    error = null;
    details = null;

    void fetchMediaDetails(item, controller.signal)
      .then((result) => {
        if (
          !controller.signal.aborted &&
          `${item.mediaType}:${item.id}` === selectedKey
        ) {
          details = result;
        }
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          error = "Could not load the full title information.";
          console.error("TMDB details request failed", reason);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });

    return () => controller.abort();
  });

  const shown = $derived(details ?? item);
  const year = $derived(shown?.releaseDate?.slice(0, 4) ?? "—");
  const poster = $derived(
    shown ? tmdbPosterUrl(shown.posterPath, "w500") : null,
  );
  const rating = $derived(
    shown?.rating === null || !shown ? null : shown.rating.toFixed(1),
  );
</script>

<Drawer
  bind:open
  snapPoints={[compactSnapPoint, expandedSnapPoint]}
  bind:activeSnapPoint
  handleOnly
  repositionInputs
  scaleBackground
  setBackgroundColorOnScale
  backgroundColor="#000000"
  class="flex h-[94dvh] min-h-0 max-h-[94dvh] flex-col overflow-hidden rounded-t-[24px] border border-app-separator bg-app-surface text-app-label shadow-2xl"
>
  {#snippet overlay(props)}
    <div {...props} class="fixed inset-0 bg-black/70 backdrop-blur-sm"></div>
  {/snippet}

  {#snippet handle(props)}
    <div
      {...props}
      class="flex h-8 w-full items-center justify-center bg-transparent"
      aria-label="Drag to resize details"
    >
      <span class="h-1.5 w-11 rounded-full bg-apple-light-gray-3/80"></span>
    </div>
  {/snippet}

  {#snippet header({ close })}
    <div class="flex items-center justify-between px-5 pb-3 pt-0">
      <span
        class="text-xs font-semibold uppercase tracking-[0.16em] text-app-secondary-label"
        >Title details</span
      >
      <button
        type="button"
        class="rounded-full p-2 text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
        onclick={close}
        aria-label="Close details"
      >
        <svg
          class="h-5 w-5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="m6 6 12 12M18 6 6 18" />
        </svg>
      </button>
    </div>
  {/snippet}

  <div
    data-svaul-drawer-no-drag
    class="min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain"
  >
    {#if shown}
      <div class="px-5 pb-6">
        <div class="flex gap-4">
          <div
            class="h-36 w-24 shrink-0 overflow-hidden rounded-[10px] bg-app-surface-hover"
          >
            {#if poster}
              <img
                src={poster}
                alt={shown.title}
                class="h-full w-full object-cover"
              />
            {/if}
          </div>
          <div class="min-w-0 pt-1">
            <p
              class="text-xs font-semibold uppercase tracking-wide text-apple-green"
            >
              {shown.mediaType === "tv" ? "TV show" : "Movie"}
            </p>
            <h2 class="mt-1 text-2xl font-extrabold leading-tight">
              {shown.title}
            </h2>
            <p class="mt-2 text-sm font-semibold text-app-secondary-label">
              {year}
              {#if isExpanded && details?.runtime}
                · {details.runtime} min{/if}
              {#if isExpanded && details?.numberOfSeasons}
                · {details.numberOfSeasons} season{details.numberOfSeasons === 1
                  ? ""
                  : "s"}{/if}
            </p>
            {#if rating}
              <p class="mt-2 inline-flex items-center gap-1 text-sm font-bold">
                {rating}<span class="text-apple-yellow">★</span>
                {#if isExpanded && details?.voteCount}<span
                    class="font-medium text-app-secondary-label"
                    >({details.voteCount.toLocaleString()})</span
                  >{/if}
              </p>
            {/if}
          </div>
        </div>

        <section class="mt-5">
          <h3 class="text-sm font-bold">Overview</h3>
          <p class="mt-2 text-sm leading-6 text-app-secondary-label">
            {shown.overview || "No overview is available for this title yet."}
          </p>
        </section>

        {#if isExpanded}
          {#if details?.genres.length}
            <div class="mt-5 flex flex-wrap gap-2">
              {#each details.genres as genre}
                <span
                  class="rounded-[5px] border border-app-separator bg-apple-white/5 px-2.5 py-1 text-xs font-semibold text-app-secondary-label"
                  >{genre}</span
                >
              {/each}
            </div>
          {/if}

          {#if details?.tagline}
            <p
              class="mt-5 text-sm font-semibold italic text-app-secondary-label"
            >
              “{details.tagline}”
            </p>
          {/if}

          {#if loading}
            <div class="mt-6 space-y-2" aria-label="Loading title details">
              <div
                class="h-4 w-24 animate-pulse rounded bg-apple-white/10"
              ></div>
              <div
                class="h-16 animate-pulse rounded-[10px] bg-apple-white/10"
              ></div>
            </div>
          {:else if error}
            <p class="mt-5 text-sm text-apple-red">{error}</p>
          {:else if details}
            <div
              class="mt-6 grid grid-cols-2 gap-3 border-y border-app-separator py-4 text-sm"
            >
              {#if details.status}<div>
                  <p class="text-app-secondary-label">Status</p>
                  <p class="mt-1 font-semibold">{details.status}</p>
                </div>{/if}
              {#if details.originalLanguage}<div>
                  <p class="text-app-secondary-label">Language</p>
                  <p class="mt-1 font-semibold">{details.originalLanguage}</p>
                </div>{/if}
              {#if details.numberOfEpisodes}<div>
                  <p class="text-app-secondary-label">Episodes</p>
                  <p class="mt-1 font-semibold">{details.numberOfEpisodes}</p>
                </div>{/if}
              {#if details.networks.length}<div>
                  <p class="text-app-secondary-label">Networks</p>
                  <p class="mt-1 font-semibold">
                    {details.networks.join(", ")}
                  </p>
                </div>{/if}
              {#if details.creators.length}<div class="col-span-2">
                  <p class="text-app-secondary-label">Created by</p>
                  <p class="mt-1 font-semibold">
                    {details.creators.join(", ")}
                  </p>
                </div>{/if}
            </div>

            {#if details.seasons.length}
              <section class="mt-6">
                <h3 class="text-sm font-bold">Seasons</h3>
                <div class="mt-3 space-y-2">
                  {#each details.seasons.filter((season) => season.seasonNumber > 0) as season (season.seasonNumber)}
                    <div
                      class="flex items-center justify-between rounded-[10px] bg-apple-white/5 px-3 py-2.5 text-sm"
                    >
                      <span class="font-semibold"
                        >{season.name || `Season ${season.seasonNumber}`}</span
                      >
                      {#if season.episodeCount}<span
                          class="text-app-secondary-label"
                          >{season.episodeCount} episodes</span
                        >{/if}
                    </div>
                  {/each}
                </div>
              </section>
            {/if}

            {#if details.cast.length}
              <section class="mt-6">
                <h3 class="text-sm font-bold">Cast</h3>
                <div class="no-scrollbar mt-3 flex gap-3 overflow-x-auto pb-1">
                  {#each details.cast as person (person.id)}
                    <div class="w-20 shrink-0">
                      <div
                        class="aspect-square overflow-hidden rounded-full bg-app-surface-hover"
                      >
                        {#if person.profilePath}
                          <img
                            src={tmdbPosterUrl(person.profilePath, "w185")}
                            alt={person.name}
                            class="h-full w-full object-cover"
                            loading="lazy"
                          />
                        {:else}
                          <div
                            class="flex h-full items-center justify-center text-lg font-bold text-app-secondary-label"
                          >
                            {person.name.slice(0, 1)}
                          </div>
                        {/if}
                      </div>
                      <p class="mt-2 truncate text-xs font-semibold">
                        {person.name}
                      </p>
                      {#if person.character}<p
                          class="truncate text-xs text-app-secondary-label"
                        >
                          {person.character}
                        </p>{/if}
                    </div>
                  {/each}
                </div>
              </section>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}
  </div>
  {#snippet footer()}
    <div
      class="z-20 border-t border-app-separator bg-app-surface px-5 pt-3 shadow-[0_-12px_24px_rgb(0_0_0_/_0.28)]"
      style="padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 24px);"
    >
      <button
        type="button"
        class="flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-apple-green text-base font-extrabold text-apple-black transition-transform active:scale-[0.98]"
        onclick={() => shown && onPlay(shown)}
      >
        <svg
          class="h-5 w-5"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          ><path
            d="M8 5.14v13.72a1 1 0 0 0 1.53.85l10.78-6.86a1 1 0 0 0 0-1.7L9.53 4.29A1 1 0 0 0 8 5.14Z"
          /></svg
        >
        Play
      </button>
    </div>
  {/snippet}
</Drawer>

<style>
  .no-scrollbar {
    scrollbar-width: none;
  }
  .no-scrollbar::-webkit-scrollbar {
    display: none;
  }
</style>
