<script lang="ts">
  interface Props {
    options: string[];
    selected?: string[];
    min?: number;
    label?: string;
    onChange?: (selected: string[]) => void;
  }

  let {
    options,
    selected = $bindable([...options]),
    min = 0,
    label = "",
    onChange = () => {},
  }: Props = $props();

  function toggle(option: string) {
    const isActive = selected.includes(option);
    if (isActive && selected.length <= min) return;

    selected = isActive
      ? selected.filter((value) => value !== option)
      : [...selected, option];
    onChange(selected);
  }
</script>

<div class="inline-flex shrink-0 flex-nowrap items-center gap-2">
  {#if label}
    <span class="text-sm font-semibold text-app-label">{label}</span>
  {/if}

  {#each options as option (option)}
    {@const isActive = selected.includes(option)}
    {@const isLocked = isActive && selected.length <= min}

    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-[5px] border px-3 py-1 text-sm font-semibold transition-colors {isActive
        ? 'border-apple-white/25 bg-app-surface text-app-label'
        : 'border-app-separator bg-app-surface/60 text-app-secondary-label hover:bg-app-surface-hover hover:text-app-label'} {isLocked
        ? 'cursor-not-allowed opacity-90'
        : ''}"
      aria-pressed={isActive}
      aria-disabled={isLocked}
      onclick={() => toggle(option)}
    >
      {#if isActive}
        <svg
          class="h-3.5 w-3.5 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      {/if}
      {option}
    </button>
  {/each}
</div>
