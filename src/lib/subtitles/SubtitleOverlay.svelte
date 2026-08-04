<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { SubtitleCue } from "./parser";

  interface Props {
    /** The video element to sync with. */
    video: HTMLVideoElement | null;
    /** Parsed subtitle cues. */
    cues: SubtitleCue[];
    /** Delay in seconds (positive = subtitles later, negative = earlier). */
    delay?: number;
  }

  let { video, cues, delay = 0 }: Props = $props();

  let currentText = $state("");
  let container = $state<HTMLDivElement | null>(null);
  let rafId: number | null = null;

  function update() {
    if (!video || cues.length === 0) {
      currentText = "";
      return;
    }

    const time = video.currentTime + delay;
    const active = cues.filter((cue) => time >= cue.start && time <= cue.end);
    currentText = active.map((cue) => cue.text).join("\n");
  }

  function onTimeUpdate() {
    update();
  }

  function onSeeked() {
    update();
  }

  onMount(() => {
    if (video) {
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("seeked", onSeeked);
      update();
    }
  });

  onDestroy(() => {
    if (video) {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }
  });

  // Re-update when cues or delay change
  $effect(() => {
    // Touch the reactive dependencies
    void cues;
    void delay;
    update();
  });
</script>

{#if currentText}
  <div
    bind:this={container}
    class="pointer-events-none absolute inset-x-0 bottom-16 flex justify-center px-4"
  >
    <div class="max-w-[80%] rounded-md bg-black/75 px-4 py-2 text-center text-lg font-medium leading-snug text-white shadow-lg sm:text-xl">
      {#each currentText.split("\n") as line}
        <div>{line}</div>
      {/each}
    </div>
  </div>
{/if}
