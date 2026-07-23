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
    <span class="text-[15px] font-semibold text-app-label">{label}</span>
  {/if}

  {#each options as option (option)}
    {@const isActive = selected.includes(option)}
    {@const isLocked = isActive && selected.length <= min}

    <button
      type="button"
      class="rounded-[5px] border px-4 py-1.5 text-[15px] font-semibold transition-colors {isActive
        ? 'border-apple-white/25 bg-app-surface text-app-label'
        : 'border-app-separator bg-app-surface/60 text-app-secondary-label hover:bg-app-surface-hover hover:text-app-label'} {isLocked
        ? 'cursor-not-allowed opacity-90'
        : ''}"
      aria-pressed={isActive}
      aria-disabled={isLocked}
      onclick={() => toggle(option)}
    >
      {option}
    </button>
  {/each}
</div>
