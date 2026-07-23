<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    options: string[];
    value?: string;
    label?: string;
    /** Optional leading content rendered inside the trigger button. */
    triggerIcon?: Snippet;
    onChange?: (value: string) => void;
  }

  let {
    options,
    value = $bindable(options[0]),
    label = "",
    triggerIcon,
    onChange = () => {},
  }: Props = $props();

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let menuStyle = $state("");

  function positionMenu() {
    if (!triggerEl) return;
    const rect = triggerEl.getBoundingClientRect();
    menuStyle = `top:${rect.bottom + 8}px;left:${rect.left}px;min-width:${Math.max(rect.width, 160)}px;`;
  }

  function toggleOpen() {
    open = !open;
    if (open) positionMenu();
  }

  function select(option: string) {
    value = option;
    onChange(option);
    open = false;
  }

  function closeOnOutside(node: HTMLElement) {
    function handleClick(event: MouseEvent) {
      if (!node.contains(event.target as Node)) open = false;
    }
    function handleScroll() {
      open = false;
    }

    document.addEventListener("click", handleClick, true);
    document.addEventListener("scroll", handleScroll, true);
    return {
      destroy() {
        document.removeEventListener("click", handleClick, true);
        document.removeEventListener("scroll", handleScroll, true);
      },
    };
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") open = false;
  }
</script>

<div
  class="relative inline-flex shrink-0 items-center gap-2"
  use:closeOnOutside
  onkeydown={handleKeydown}
>
  {#if label}
    <span class="text-[15px] font-semibold text-app-label">{label}</span>
  {/if}

  <button
    bind:this={triggerEl}
    type="button"
    class="inline-flex items-center gap-1 rounded-[10px] border border-app-separator bg-app-surface px-4 py-1.5 text-[15px] font-semibold text-app-label transition-colors hover:bg-app-surface-hover"
    onclick={toggleOpen}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if triggerIcon}
      {@render triggerIcon()}
    {/if}
    {value}
    <svg
      class="h-4 w-4 shrink-0 transition-transform duration-200"
      class:rotate-180={open}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </button>

  {#if open}
    <ul
      style={menuStyle}
      class="fixed z-50 overflow-hidden rounded-[10px] border border-app-separator bg-app-surface shadow-xl"
      role="listbox"
    >
      {#each options as option (option)}
        <li role="presentation">
          <button
            type="button"
            class="flex w-full items-center justify-between px-4 py-2.5 text-left text-[15px] font-medium text-app-label transition-colors hover:bg-app-surface-hover"
            class:bg-app-surface-hover={option === value}
            role="option"
            aria-selected={option === value}
            onclick={() => select(option)}
          >
            {option}
            {#if option === value}
              <svg
                class="h-4 w-4 shrink-0 text-apple-blue"
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
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>
