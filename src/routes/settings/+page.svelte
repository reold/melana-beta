<script lang="ts">
  import { browser } from "$app/environment";
  import { afterNavigate, goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import ContourTexture from "$lib/assets/contour-texture.png";
  import { proxyOrigin } from "$lib/streaming/client";

  interface CommitInfo {
    sha: string;
    htmlUrl: string;
    message: string;
    authorName: string | null;
    authorDate: string | null;
    authorLogin: string | null;
    authorAvatarUrl: string | null;
  }

  interface ProxyStatus {
    status: string | null;
    service: string | null;
    cache: {
      currentBytes: number;
      maxBytes: number;
      utilizationPercent: number;
      segmentEntries: number;
      manifestEntries: number;
    };
    inflightFetches: number;
    hostsTracked: number;
    hostsCoolingDown: number;
    upstreamRequests: number;
    upstreamThrottled: number;
    proxyPool: {
      total: number;
      healthy: number;
      bestLatencyMs: number | null;
    };
  }

  const REPO = "reold/melana-beta";
  const GITHUB_API = "https://api.github.com";

  let repoUrl = $state("https://github.com/reold/melana-beta");
  let defaultBranch = $state<string | null>(null);
  let commits = $state<CommitInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let proxyStatus = $state<ProxyStatus | null>(null);
  let proxyLoading = $state(true);
  let proxyError = $state<string | null>(null);

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
          fetch(`${GITHUB_API}/repos/${REPO}/commits?per_page=1`, {
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

  // Status of the melana-rs stream proxy, fetched from its /fetch endpoint.
  $effect(() => {
    if (!browser) return;
    const controller = new AbortController();
    proxyLoading = true;
    proxyError = null;

    void (async () => {
      try {
        const response = await fetch(`${proxyOrigin}/fetch`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Proxy status returned ${response.status}.`);
        }
        const raw: any = await response.json();

        const num = (value: any): number =>
          typeof value === "number" && Number.isFinite(value) ? value : 0;

        proxyStatus = {
          status: typeof raw.status === "string" ? raw.status : null,
          service: typeof raw.service === "string" ? raw.service : null,
          cache: {
            currentBytes: num(raw.cache?.current_bytes),
            maxBytes: num(raw.cache?.max_bytes),
            utilizationPercent: num(raw.cache?.utilization_percent),
            segmentEntries: num(raw.cache?.segment_entries),
            manifestEntries: num(raw.cache?.manifest_entries),
          },
          inflightFetches: num(raw.inflight_fetches),
          hostsTracked: num(raw.hosts_tracked),
          hostsCoolingDown: num(raw.hosts_cooling_down),
          upstreamRequests: num(raw.upstream_requests),
          upstreamThrottled: num(raw.upstream_throttled),
          proxyPool: {
            total: num(raw.proxy_pool?.total),
            healthy: num(raw.proxy_pool?.healthy),
            bestLatencyMs:
              typeof raw.proxy_pool?.best_latency_ms === "number"
                ? raw.proxy_pool.best_latency_ms
                : null,
          },
        };
      } catch (reason) {
        if (controller.signal.aborted) return;
        proxyError =
          reason instanceof Error
            ? reason.message
            : "Could not reach the proxy status endpoint.";
      } finally {
        if (!controller.signal.aborted) proxyLoading = false;
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

  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exponent = Math.min(
      Math.floor(Math.log(bytes) / Math.log(1024)),
      units.length - 1,
    );
    const value = bytes / 1024 ** exponent;
    return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  /** Clamp cache utilization into 0..100 for the bar width. */
  function cachePercent(percent: number): number {
    return Math.min(100, Math.max(0, percent));
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

      <!-- Version: latest commit from GitHub -->
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
              d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5"
            />
          </svg>
          <h2 class="text-lg font-bold">Version</h2>
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
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"
                  />
                </svg>
                {REPO} · {defaultBranch}
              </a>
            </div>
          {/if}

        {/if}
      </section>

      <!-- Server: live status of the melana-rs stream proxy -->
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
              d="M5.25 14.25h13.5m-13.5 0a3 3 0 0 1-3-3m3 3a3 3 0 1 0 0 6h13.5a3 3 0 1 0 0-6m-16.5-3a3 3 0 0 1 3-3h13.5a3 3 0 0 1 3 3m-19.5 0a4.5 4.5 0 0 1 .9-2.7L5.737 5.1a3.375 3.375 0 0 1 2.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 0 1 .9 2.7m0 0a3 3 0 0 1-3 3m0 3h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Zm-3 6h.008v.008h-.008v-.008Zm0-6h.008v.008h-.008v-.008Z"
            />
          </svg>
          <h2 class="text-lg font-bold">Server</h2>
        </div>

        {#if proxyLoading}
          <div
            class="flex items-center gap-3 px-1 py-6 text-sm text-app-secondary-label"
            aria-live="polite"
          >
            <span
              class="h-4 w-4 animate-spin rounded-full border-2 border-app-secondary-label border-t-transparent"
            ></span>
            Fetching server status…
          </div>
        {:else if proxyError}
          <p class="px-1 py-6 text-sm text-apple-red">{proxyError}</p>
        {:else if proxyStatus}
          {@const online = proxyStatus.status === "online"}
          <div class="rounded-xl border border-app-separator bg-app-canvas/60 p-4">
            <!-- Status + service -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span
                class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide {online
                  ? 'bg-apple-green/15 text-apple-green'
                  : 'bg-apple-red/15 text-apple-red'}"
              >
                <span
                  class="h-1.5 w-1.5 rounded-full {online
                    ? 'bg-apple-green'
                    : 'bg-apple-red'}"
                  aria-hidden="true"
                ></span>
                {online ? "Online" : (proxyStatus.status ?? "Offline")}
              </span>
              {#if proxyStatus.service}
                <span class="text-sm font-semibold text-app-label">
                  {proxyStatus.service}
                </span>
              {/if}
            </div>

            <!-- Cache utilization -->
            <div class="mt-4">
              <div class="flex items-baseline justify-between gap-3 text-xs">
                <span class="font-semibold text-app-label">Cache</span>
                <span class="tabular-nums text-app-secondary-label">
                  {proxyStatus.cache.utilizationPercent.toFixed(2)}%
                </span>
              </div>
              <div
                class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-app-canvas"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={cachePercent(proxyStatus.cache.utilizationPercent)}
                aria-label="Cache utilization"
              >
                <div
                  class="h-full rounded-full transition-all duration-500 {online
                    ? 'bg-apple-aqua'
                    : 'bg-apple-red'}"
                  style="width: {cachePercent(proxyStatus.cache.utilizationPercent)}%"
                ></div>
              </div>
              <p class="mt-1.5 text-[11px] tabular-nums text-app-secondary-label">
                {formatBytes(proxyStatus.cache.currentBytes)}
                <span aria-hidden="true">/</span>
                {formatBytes(proxyStatus.cache.maxBytes)}
                <span aria-hidden="true">·</span>
                {proxyStatus.cache.segmentEntries} segments
                <span aria-hidden="true">·</span>
                {proxyStatus.cache.manifestEntries} manifests
              </p>
            </div>

            <!-- Stats grid -->
            <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  Upstream requests
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.upstreamRequests}
                </dd>
              </div>
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  In-flight fetches
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.inflightFetches}
                </dd>
              </div>
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  Hosts tracked
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.hostsTracked}
                  {#if proxyStatus.hostsCoolingDown > 0}
                    <span class="text-xs text-app-secondary-label">
                      ({proxyStatus.hostsCoolingDown} cooling)
                    </span>
                  {/if}
                </dd>
              </div>
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  Proxy pool
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.proxyPool.healthy}/{proxyStatus.proxyPool.total}
                  <span class="text-xs text-app-secondary-label">healthy</span>
                </dd>
              </div>
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  Best latency
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.proxyPool.bestLatencyMs !== null
                    ? `${proxyStatus.proxyPool.bestLatencyMs} ms`
                    : "—"}
                </dd>
              </div>
              <div>
                <dt class="text-[11px] uppercase tracking-wide text-app-secondary-label">
                  Upstream throttled
                </dt>
                <dd class="text-sm font-semibold tabular-nums text-app-label">
                  {proxyStatus.upstreamThrottled}
                </dd>
              </div>
            </dl>
          </div>
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
