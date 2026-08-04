<script lang="ts">
  import type { Snippet } from "svelte";
  import { portal } from "./portal";

  export type DropdownOption = string | { label: string; value: string };

  interface Props {
    options: DropdownOption[];
    value?: string;
    label?: string;
    /** Optional leading content rendered inside the trigger button. */
    triggerIcon?: Snippet;
    onChange?: (value: string) => void;
    /** When true the trigger stretches to fill its row (for full-width menus). */
    stretch?: boolean;
    /** Extra classes applied to the trigger's label text (e.g. truncation limits). */
    triggerLabelClass?: string;
  }

  function optionLabel(option: DropdownOption): string {
    return typeof option === "string" ? option : option.label;
  }
  function optionValue(option: DropdownOption): string {
    return typeof option === "string" ? option : option.value;
  }

  const displayLabel = $derived.by(() => {
    const match = options.find((o) => optionValue(o) === value);
    return match ? optionLabel(match) : value;
  });

  let {
    options,
    value = $bindable(options[0] !== undefined ? optionValue(options[0]) : ""),
    label = "",
    triggerIcon,
    onChange = () => {},
    stretch = false,
    triggerLabelClass = "",
  }: Props = $props();

  /** Distance between trigger and menu, and the minimum gap to a viewport edge. */
  const GAP = 8;
  const EDGE_MARGIN = 8;
  const MIN_MENU_WIDTH = 160;
  /** Assumed menu height before it has been rendered and measured. */
  const ESTIMATED_MENU_HEIGHT = 168;

  let open = $state(false);
  let triggerEl = $state<HTMLButtonElement | null>(null);
  let anchorEl = $state<HTMLElement | null>(null);
  let menuEl = $state<HTMLElement | null>(null);
  let menuStyle = $state("");

  /**
   * The menu is portalled to <body> and positioned against the trigger's
   * viewport rect: the toolbar it lives in is a horizontal scroller, and an
   * overflow ancestor clips `position: fixed` descendants on iOS Safari, which
   * made the menu invisible behind the poster grid.
   */
  function positionMenu() {
    if (!triggerEl) return;

    const rect = triggerEl.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(rect.width, MIN_MENU_WIDTH);

    const left = Math.round(
      Math.min(Math.max(EDGE_MARGIN, rect.left), Math.max(EDGE_MARGIN, viewportWidth - width - EDGE_MARGIN)),
    );
    // `scrollHeight` is the full content height even once max-height clamps it,
    // so the flip decision stays stable while the menu is open.
    const wanted = menuEl?.scrollHeight || ESTIMATED_MENU_HEIGHT;
    const spaceBelow = viewportHeight - rect.bottom - GAP - EDGE_MARGIN;
    const spaceAbove = rect.top - GAP - EDGE_MARGIN;
    const flipUp = spaceBelow < wanted && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, Math.round(flipUp ? spaceAbove : spaceBelow));

    const vertical = flipUp
      ? `bottom:${Math.round(viewportHeight - rect.top + GAP)}px`
      : `top:${Math.round(rect.bottom + GAP)}px`;

    menuStyle = `left:${left}px;${vertical};min-width:${Math.round(width)}px;max-height:${maxHeight}px;`;
  }

  function toggleOpen() {
    open = !open;
    if (open) positionMenu();
  }

  function select(option: DropdownOption) {
    const next = optionValue(option);
    value = next;
    onChange(next);
    open = false;
  }

  function isInside(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return false;
    return Boolean(anchorEl?.contains(target) || menuEl?.contains(target));
  }

  // Re-run positioning once the menu exists, now that its height is measurable.
  $effect(() => {
    if (!open || !menuEl) return;
    positionMenu();
  });

  $effect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      if (!isInside(event.target)) open = false;
    }

    function handleScroll(event: Event) {
      // Scrolling the menu itself must not dismiss it.
      if (isInside(event.target)) return;
      open = false;
    }

    function handleKeydown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      open = false;
      triggerEl?.focus();
    }

    function handleReposition() {
      positionMenu();
    }

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("scroll", handleScroll, true);
    document.addEventListener("keydown", handleKeydown);
    window.addEventListener("resize", handleReposition);
    window.addEventListener("orientationchange", handleReposition);
    window.visualViewport?.addEventListener("resize", handleReposition);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("scroll", handleScroll, true);
      document.removeEventListener("keydown", handleKeydown);
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("orientationchange", handleReposition);
      window.visualViewport?.removeEventListener("resize", handleReposition);
    };
  });
</script>

<div
  bind:this={anchorEl}
  class="relative inline-flex shrink-0 items-center gap-2 {stretch ? 'w-full' : ''}"
>
  {#if label}
    <span class="text-sm font-semibold text-app-label">{label}</span>
  {/if}

  <button
    bind:this={triggerEl}
    type="button"
    class="inline-flex items-center gap-1 rounded-[10px] border border-app-separator bg-app-surface px-3 py-1 text-sm font-semibold text-app-label transition-colors hover:bg-app-surface-hover {stretch
      ? 'w-full justify-between'
      : ''}"
    onclick={toggleOpen}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {#if triggerIcon}
      {@render triggerIcon()}
    {/if}
    <span class="min-w-0 truncate {triggerLabelClass}">{displayLabel}</span>
    <svg
      class="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
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
</div>

{#if open}
  <ul
    bind:this={menuEl}
    {@attach portal()}
    style={menuStyle}
    class="fixed z-[60] overflow-y-auto overscroll-contain rounded-[10px] border border-app-separator bg-app-surface shadow-xl"
    role="listbox"
    aria-label={label || "Options"}
  >
    {#each options as option (optionValue(option))}
      <li role="presentation">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm font-medium text-app-label transition-colors hover:bg-app-surface-hover"
          class:bg-app-surface-hover={optionValue(option) === value}
          role="option"
          aria-selected={optionValue(option) === value}
          onclick={() => select(option)}
        >
          {optionLabel(option)}
          {#if optionValue(option) === value}
            <svg
              class="h-3.5 w-3.5 shrink-0 text-apple-blue"
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
