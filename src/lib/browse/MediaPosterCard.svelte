<script lang="ts">
  import { tmdbPosterUrl } from "$lib/tmdb/client";
  import type { MediaSummary } from "$lib/tmdb/types";

  interface Props {
    item: MediaSummary;
    onSelect?: (item: MediaSummary) => void;
  }

  let { item, onSelect = () => {} }: Props = $props();

  const releaseYear = $derived(item.releaseDate?.slice(0, 4) ?? "—");
  const rating = $derived(
    item.rating === null ? null : String(Math.round(item.rating)),
  );
  const posterUrl = $derived(tmdbPosterUrl(item.posterPath));
</script>

<button
  type="button"
  class="group w-full overflow-hidden rounded-2xl bg-app-surface text-left shadow-lg transition-transform active:scale-[0.97]"
  onclick={() => onSelect(item)}
  aria-label={`Open ${item.title}`}
>
  <div class="relative aspect-[3/4] overflow-hidden bg-app-surface-hover">
    {#if posterUrl}
      <img
        src={posterUrl}
        alt={item.title}
        class="h-full w-full object-cover"
        loading="lazy"
      />
    {:else}
      <div
        class="flex h-full items-end p-3 text-sm font-semibold text-app-label"
      >
        {item.title}
      </div>
    {/if}
  </div>

  <div
    class="flex h-8 items-center px-3 text-[15px] font-bold tabular-nums text-app-label"
  >
    <span>{releaseYear}</span>
    <span class="mx-2 h-px flex-1 bg-app-separator" aria-hidden="true"></span>
    {#if rating}
      <span class="inline-flex items-center gap-0.5">
        {rating}
        <svg
          class="h-4 w-4 text-apple-yellow"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="m12 2.25 2.924 5.925 6.54.95-4.732 4.613 1.117 6.514L12 17.176l-5.85 3.076 1.117-6.514L2.535 9.125l6.54-.95L12 2.25Z"
          />
        </svg>
      </span>
    {/if}
  </div>
</button>
