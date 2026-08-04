<script lang="ts">
  import { browser } from "$app/environment";
  import { afterNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import ContourTexture from "$lib/assets/contour-texture.png";

  interface CommitInfo {
    sha: string;
    htmlUrl: string;
    message: string;
    authorName: string | null;
    authorDate: string | null;
    authorLogin: string | null;
    authorAvatarUrl: string | null;
  }

  const REPO = "reold/melana-beta";
  const GITHUB_API = "https://api.github.com";

  let repoUrl = $state("https://github.com/reold/melana-beta");
  let defaultBranch = $state<string | null>(null);
  let commits = $state<CommitInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Live fetch from the public GitHub API (no token required). Runs only in
  // the browser so the page still renders (with a loading state) during SSR.
  $effect(() => {
    if (!browser) return;
    const controller = new AbortController();
    loading = true;
    error = null;

    void (async () => {
      try {
        const headers = { Accept: "application/vnd.github+json" };
        const [repoResponse, commitsResponse] = await Promise.all([
          fetch(`${GITHUB_API}/repos/${REPO}`, {
            signal: controller.signal,
            headers,
          }),
          fetch(`${GITHUB_API}/repos/${REPO}/commits?per_page=5`, {
            signal: controller.signal,
            headers,
          }),
        ]);

        if (!repoResponse.ok || !commitsResponse.ok) {
          const status = repoResponse.ok
            ? commitsResponse.status
            : repoResponse.status;
          if (status === 403 || status === 429) {
            throw new Error(
              "GitHub API rate limit reached. Try again in a bit.",
            );
          }
          throw new Error(`GitHub API returned ${status}.`);
        }

        const repoData = await repoResponse.json();
        const commitData = await commitsResponse.json();
        if (!Array.isArray(commitData)) {
          throw new Error("GitHub API returned an unexpected response.");
        }

        repoUrl = repoData.html_url ?? repoUrl;
        defaultBranch = repoData.default_branch ?? "main";

        commits = commitData.map((raw: any) => ({
          sha: typeof raw.sha === "string" ? raw.sha : "",
          htmlUrl:
            typeof raw.html_url === "string"
              ? raw.html_url
              : `https://github.com/${REPO}/commit/${
                  typeof raw.sha === "string" ? raw.sha : ""
                }`,
          message:
            typeof raw.commit?.message === "string"
              ? raw.commit.message
              : "No commit message",
          authorName:
            typeof raw.commit?.author?.name === "string"
              ? raw.commit.author.name
              : null,
          authorDate:
            typeof raw.commit?.author?.date === "string"
              ? raw.commit.author.date
              : null,
          authorLogin:
            typeof raw.author?.login === "string" ? raw.author.login : null,
          authorAvatarUrl:
            typeof raw.author?.avatar_url === "string"
              ? raw.author.avatar_url
              : null,
        }));
      } catch (reason) {
        if (controller.signal.aborted) return;
        error =
          reason instanceof Error
            ? reason.message
            : "Could not reach the GitHub API.";
      } finally {
        if (!controller.signal.aborted) loading = false;
      }
    })();

    return () => controller.abort();
  });

  function shortHash(sha: string): string {
    return sha.slice(0, 7);
  }

  /** First line of the commit message. */
  function messageTitle(message: string): string {
    return message.split("\n")[0] || message;
  }

  /** Remaining lines of the commit message, if any. */
  function messageBody(message: string): string | null {
    const rest = message.split("\n").slice(1).join("\n").trim();
    return rest || null;
  }

  // Stepping back through history (instead of pushing a fresh /browse entry)
  // is what lets Browse restore the exact list, sheet and scroll the user
  // left. Only safe when we know the previous entry is Browse.
  let cameFromBrowse = $state(false);
  afterNavigate((navigation) => {
    cameFromBrowse = navigation.from?.route.id === "/browse";
  });

  function leaveToBrowse() {
    if (cameFromBrowse) {
      history.back();
      return;
    }
    void goto(resolve("/browse"));
  }

  function formatDateTime(iso: string): string {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  }

  function timeAgo(iso: string): string {
    const diffMs = new Date(iso).getTime() - Date.now();
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
      ["year", 31_536_000],
      ["month", 2_592_000],
      ["week", 604_800],
      ["day", 86_400],
      ["hour", 3_600],
      ["minute", 60],
      ["second", 1],
    ];
    for (const [unit, seconds] of units) {
      const value = diffMs / 1000 / seconds;
      if (Math.abs(value) >= 1 || unit === "second") {
        return rtf.format(Math.round(value), unit);
      }
    }
    return "just now";
  }
</script>

<svelte:head>
  <title>Settings - Melana</title>
</svelte:head>

<main class="min-h-screen bg-app-canvas text-app-label">
  <!-- Header, matching the Browse page -->
  <header class="relative overflow-hidden px-5 pb-4 pt-10">
    <div
      class="pointer-events-none absolute inset-0 mask-cover mask-center bg-linear-to-b from-apple-aqua from-80% to-black opacity-25"
      style="mask-image: url({ContourTexture});"
    ></div>
    <div class="texture-fade" aria-hidden="true"></div>
    <div class="relative z-10 flex items-center gap-1">
      <button
        type="button"
        class="inline-flex items-center rounded-lg p-2 text-app-secondary-label hover:bg-apple-white/10 hover:text-app-label"
        onclick={leaveToBrowse}
        aria-label="Back to browse"
      >
        <svg class="h-6 w-6" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
      </button>
      <h1 class="text-5xl font-extrabold leading-none tracking-tight">
        Settings
      </h1>
    </div>
  </header>

  <div class="px-4 pb-10 sm:px-8">
    <div class="mx-auto max-w-6xl space-y-4">
      <!-- Body – empty for now -->
      <section class="rounded-2xl border border-app-separator bg-app-surface p-6">
        <p class="text-sm text-app-secondary-label">
          Nothing here yet — settings are coming soon.
        </p>
      </section>

      <!-- Development: latest commit from GitHub -->
      <section class="rounded-2xl border border-app-separator bg-app-surface p-4">
        <div class="flex items-center gap-2 px-1 pb-3">
          <svg
            class="h-4 w-4 shrink-0 text-app-secondary-label"
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
              d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L6.832 19.82a4.5 4.5 0 0 1-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 0 1 1.13-1.897L16.863 4.487Zm0 0L19.5 7.125"
            />
          </svg>
          <h2 class="text-lg font-bold">Development</h2>
          {#if !loading && !error}
            <span
              class="rounded-full bg-apple-green/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-apple-green"
            >
              Live
            </span>
          {/if}
        </div>

        {#if loading}
          <div
            class="flex items-center gap-3 px-1 py-6 text-sm text-app-secondary-label"
            aria-live="polite"
          >
            <span
              class="h-4 w-4 animate-spin rounded-full border-2 border-app-secondary-label border-t-transparent"
            ></span>
            Fetching latest commit…
          </div>
        {:else if error}
          <p class="px-1 py-6 text-sm text-apple-red">{error}</p>
        {:else if commits.length > 0}
          {@const latest = commits[0]}
          {@const latestDate = latest.authorDate ?? ""}
          <div class="rounded-xl border border-app-separator bg-app-canvas/60 p-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-semibold leading-snug">{messageTitle(latest.message)}</p>
                {#if messageBody(latest.message)}
                  <p class="mt-1 whitespace-pre-line text-xs text-app-secondary-label">
                    {messageBody(latest.message)}
                  </p>
                {/if}
              </div>
              <a
                href={latest.htmlUrl}
                target="_blank"
                rel="noreferrer"
                class="shrink-0 rounded-md border border-app-separator bg-app-surface px-2 py-1 font-mono text-xs font-semibold text-apple-blue transition-colors hover:bg-app-surface-hover"
                title={latest.sha}
              >
                {shortHash(latest.sha)}
              </a>
            </div>

            <div
              class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-app-secondary-label"
            >
              {#if latest.authorAvatarUrl}
                <img
                  src={latest.authorAvatarUrl}
                  alt=""
                  class="h-4 w-4 rounded-full"
                />
              {/if}
              <span class="font-semibold text-app-label">
                {latest.authorName ?? latest.authorLogin ?? "Unknown"}
              </span>
              {#if latestDate}
                <span aria-hidden="true">·</span>
                <time datetime={latestDate} title={formatDateTime(latestDate)}>
                  {timeAgo(latestDate)}
                </time>
              {/if}
              <span aria-hidden="true">·</span>
              <span class="truncate font-mono text-[11px]">{latest.sha}</span>
            </div>
          </div>

          {#if defaultBranch}
            <div class="mt-3 flex flex-wrap items-center gap-2 px-1">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1.5 rounded-md border border-app-separator bg-app-canvas/60 px-2 py-1 text-xs font-semibold text-app-secondary-label transition-colors hover:bg-app-surface-hover hover:text-app-label"
              >
                <svg
                  class="h-3.5 w-3.5"
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
                    d="M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 0 1 3 12c0-1.605.42-3.113 1.157-4.418"
                  />
                </svg>
                {REPO} · {defaultBranch}
              </a>
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                class="inline-flex items-center gap-1.5 rounded-md border border-app-separator bg-app-canvas/60 px-2 py-1 text-xs font-semibold text-app-secondary-label transition-colors hover:bg-app-surface-hover hover:text-app-label"
              >
                View on GitHub
                <svg
                  class="h-3 w-3"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke-width="2"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
              </a>
            </div>
          {/if}

          {#if commits.length > 1}
            <ul class="mt-3 divide-y divide-app-separator border-t border-app-separator">
              {#each commits.slice(1) as commit (commit.sha)}
                <li class="flex items-center gap-3 py-2.5">
                  <a
                    href={commit.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    class="shrink-0 font-mono text-xs font-semibold text-apple-blue hover:underline"
                    title={commit.sha}
                  >
                    {shortHash(commit.sha)}
                  </a>
                  <span class="min-w-0 flex-1 truncate text-sm text-app-label">
                    {messageTitle(commit.message)}
                  </span>
                  {#if commit.authorDate}
                    <time
                      datetime={commit.authorDate}
                      class="shrink-0 text-xs text-app-secondary-label"
                      title={formatDateTime(commit.authorDate)}
                    >
                      {timeAgo(commit.authorDate)}
                    </time>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </section>
    </div>
  </div>
</main>

<style>
  .texture-fade {
    pointer-events: none;
    position: absolute;
    inset: auto 0 0;
    height: 62%;
    background: linear-gradient(
      to bottom,
      transparent 5%,
      rgb(0 0 0 / 0.28) 48%,
      #000 100%
    );
  }
</style>
