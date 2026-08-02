import Hls from "hls.js";
import {
  extractUpstreamUrl,
  fastProxiedUrl,
  isManifestUrl,
  isProxiedStreamUrl,
  proxiedManifestRawUrl,
  resolveRelativeUrl,
} from "./client";

export interface HlsAttachment {
  destroy(): void;
}

/** Matches IV/key ghost files that break playback (.ico/.key/.bin under quality folder) */
const IV_FILE_REGEX = /\/(480p|720p|1080p|4k)\/[^/]*\.(?:ico|key|bin)(?:\?[^"']*)?$/i;

function resolveUrl(relativeOrAbsolute: string, base: string): string {
  const trimmed = relativeOrAbsolute.trim();
  if (!trimmed) return trimmed;
  try {
    // If already absolute or blob:, keep as is
    if (
      /^https?:\/\//i.test(trimmed) ||
      trimmed.startsWith("blob:") ||
      trimmed.startsWith("data:")
    ) {
      return trimmed;
    }
    return resolveRelativeUrl(trimmed, base);
  } catch {
    return trimmed;
  }
}

/**
 * Core manifest rewriter:
 * - strips broken IV file references from #EXT-X-KEY
 * - rewrites all URI="..." attributes:
 *    .m3u8/.m3u -> manifestProxy (Melana raw=true)
 *    else       -> segmentProxy (fast Spadik)
 * - rewrites bare URI lines:
 *    after EXT-X-STREAM-INF or ending in .m3u8 -> manifestProxy
 *    else -> segmentProxy
 *
 * This is the heart of the "raw + second proxy" optimization:
 * manifests are still fetched via Melana (WAF bypass), but every
 * segment/key/subtitle ends up going through the fast edge proxy.
 */
export function rewriteManifest(
  text: string,
  baseUpstream: string,
  manifestProxy: (absUrl: string) => string,
  segmentProxy: (absUrl: string) => string,
): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let nextIsVariant = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      out.push(rawLine);
      nextIsVariant = false;
      continue;
    }

    // #EXT-X-STREAM-INF signals next line is variant manifest URI
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      // rewrite any URI attrs inside (rare but possible – audio group etc)
      const rewritten = rawLine.replace(/URI="([^"]+)"/g, (_m, inner: string) => {
        const abs = resolveUrl(inner, baseUpstream);
        const isM = isManifestUrl(abs);
        const proxied = isM ? manifestProxy(abs) : segmentProxy(abs);
        return `URI="${proxied}"`;
      });
      out.push(rewritten);
      nextIsVariant = true;
      continue;
    }

    if (trimmed.startsWith("#")) {
      // Special handling for #EXT-X-KEY that may reference broken IV files
      if (trimmed.startsWith("#EXT-X-KEY")) {
        const uriMatch = rawLine.match(/URI="([^"]+)"/);
        if (uriMatch) {
          const uriVal = uriMatch[1];
          const abs = resolveUrl(uriVal, baseUpstream);
          if (IV_FILE_REGEX.test(abs) || IV_FILE_REGEX.test(uriVal)) {
            // strip the broken URI, keep METHOD/IV
            let cleaned = rawLine.replace(/,?URI="[^"]*"/, "");
            cleaned = cleaned.replace(/,,/g, ",").replace(/:,/g, ":").replace(/,\s*$/, "").replace(/,\s*$/g, "");
            out.push(cleaned);
            nextIsVariant = false;
            continue;
          }
        }
      }

      // Generic tag with URI="..."
      const rewritten = rawLine.replace(/URI="([^"]+)"/g, (_m, inner: string) => {
        const abs = resolveUrl(inner, baseUpstream);
        const isM = isManifestUrl(abs);
        const proxied = isM ? manifestProxy(abs) : segmentProxy(abs);
        return `URI="${proxied}"`;
      });
      out.push(rewritten);
      nextIsVariant = false;
      continue;
    }

    // Bare URI line – could be variant manifest or segment
    const abs = resolveUrl(trimmed, baseUpstream);
    const isM = nextIsVariant || isManifestUrl(abs);
    const proxied = isM ? manifestProxy(abs) : segmentProxy(abs);
    out.push(proxied);
    nextIsVariant = false;
  }

  return out.join("\n");
}

/** Convenience wrapper that uses Melana raw for manifests and Spadik fast for segments */
export function rewriteManifestWithFastProxy(
  text: string,
  baseUpstream: string,
  noReferrer: boolean,
): string {
  return rewriteManifest(
    text,
    baseUpstream,
    (abs) => proxiedManifestRawUrl(abs, noReferrer),
    (abs) => fastProxiedUrl(abs, noReferrer),
  );
}

// ---------------------------------------------------------------------------
// HLS.js custom pLoader that rewrites every manifest on the fly
// ---------------------------------------------------------------------------

function createRewriteLoader(noReferrer: boolean) {
  // HLS.js DefaultConfig.loader is an XHR loader – we wrap its onSuccess
  const BaseLoader = (Hls as any).DefaultConfig.loader;

  return class PlaylistRewriteLoader extends BaseLoader {
    constructor(config: any) {
      super(config);
      const originalLoad = this.load.bind(this);

      this.load = (context: any, cfg: any, callbacks: any) => {
        const manifestTypes = [
          "manifest",
          "level",
          "audioTrack",
          "subtitleTrack",
        ];
        if (manifestTypes.includes(context.type)) {
          const origOnSuccess = callbacks.onSuccess;
          callbacks.onSuccess = (
            response: any,
            stats: any,
            ctx: any,
            networkDetails: any,
          ) => {
            try {
              if (typeof response.data === "string" && response.data.includes("#EXTM3U")) {
                const proxiedUrl: string = response.url || ctx?.url || context.url;
                const upstream =
                  extractUpstreamUrl(proxiedUrl) || proxiedUrl;
                // Resolve base: upstream if it looks http, otherwise try ctx
                const baseForResolve =
                  /^https?:\/\//i.test(upstream)
                    ? upstream
                    : extractUpstreamUrl(ctx?.url || "") ||
                      ctx?.url ||
                      upstream;

                const rewritten = rewriteManifestWithFastProxy(
                  response.data,
                  baseForResolve,
                  noReferrer,
                );
                response.data = rewritten;
              }
            } catch (e) {
              console.warn("[hls] manifest rewrite failed, using original", e);
            }
            origOnSuccess(response, stats, ctx, networkDetails);
          };
        }

        originalLoad(context, cfg, callbacks);
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Safari native HLS path – we must fully resolve master -> variant blobs
// ---------------------------------------------------------------------------

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function createBlobUrl(text: string): string {
  const blob = new Blob([text], {
    type: "application/vnd.apple.mpegurl",
  });
  return URL.createObjectURL(blob);
}

interface NativeBuildResult {
  masterBlob: string;
  variantBlobs: string[];
  allBlobs: string[];
}

/**
 * For Safari (no MSE) we cannot use a custom loader, so we fetch and
 * rewrite manifests ourselves into blob URLs.
 *
 * - Master playlists: fetch each variant/audio playlist via Melana raw,
 *   rewrite their segments to fast proxy -> blob, then rewrite master to
 *   point to those blobs -> blob.
 * - Variant playlists: just rewrite segments to fast proxy -> blob.
 */
async function buildNativeSrc(
  melanaRawMasterUrl: string,
  noReferrer: boolean,
  signal?: AbortSignal,
): Promise<NativeBuildResult> {
  const masterText = await fetchText(melanaRawMasterUrl, signal);
  const upstreamBase =
    extractUpstreamUrl(melanaRawMasterUrl) || melanaRawMasterUrl;

  // Not a master? Just rewrite and blob it.
  if (!masterText.includes("#EXT-X-STREAM-INF")) {
    const rewritten = rewriteManifestWithFastProxy(
      masterText,
      upstreamBase,
      noReferrer,
    );
    const blob = createBlobUrl(rewritten);
    return { masterBlob: blob, variantBlobs: [], allBlobs: [blob] };
  }

  // Master: collect variant bare URLs and any manifest URI attrs (audio groups)
  const lines = masterText.split(/\r?\n/);
  const variantAbsSet = new Map<string, string>(); // abs -> original trimmed
  const manifestUriAbsSet = new Map<string, string>(); // abs -> placeholder
  let nextIsVariant = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      nextIsVariant = false;
      continue;
    }
    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      nextIsVariant = true;
      // also collect URI="...*.m3u8" inside STREAM-INF line if any
      const re = /URI="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rawLine)) !== null) {
        const inner = m[1];
        const abs = resolveUrl(inner, upstreamBase);
        if (isManifestUrl(abs)) manifestUriAbsSet.set(abs, inner);
      }
      continue;
    }
    if (trimmed.startsWith("#")) {
      // Any URI="..." that is manifest (audio, subtitles batch) should be fetched
      const re = /URI="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(rawLine)) !== null) {
        const inner = m[1];
        const abs = resolveUrl(inner, upstreamBase);
        if (isManifestUrl(abs)) manifestUriAbsSet.set(abs, inner);
      }
      nextIsVariant = false;
      continue;
    }
    // bare line
    if (nextIsVariant) {
      const abs = resolveUrl(trimmed, upstreamBase);
      variantAbsSet.set(abs, trimmed);
    }
    nextIsVariant = false;
  }

  const allManifestAbs = [
    ...Array.from(variantAbsSet.keys()),
    ...Array.from(manifestUriAbsSet.keys()),
  ];
  const uniqueManifestAbs = Array.from(new Set(allManifestAbs));

  // Fetch all referenced manifests via Melana raw
  const fetched = await Promise.all(
    uniqueManifestAbs.map(async (abs) => {
      try {
        const proxyUrl = proxiedManifestRawUrl(abs, noReferrer);
        const txt = await fetchText(proxyUrl, signal);
        const rewritten = rewriteManifestWithFastProxy(txt, abs, noReferrer);
        const blob = createBlobUrl(rewritten);
        return { abs, blob, ok: true as const };
      } catch {
        return { abs, blob: null, ok: false as const };
      }
    }),
  );

  const absToBlob = new Map<string, string>();
  const variantBlobs: string[] = [];

  for (const item of fetched) {
    if (item.ok && item.blob) {
      absToBlob.set(item.abs, item.blob);
      // Keep track of all blobs for revocation
      variantBlobs.push(item.blob);
    }
  }

  // Now rewrite master to point bare variant lines and URI manifests to blob URLs
  const rewrittenMasterLines: string[] = [];
  nextIsVariant = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      rewrittenMasterLines.push(rawLine);
      nextIsVariant = false;
      continue;
    }

    if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const rewritten = rawLine.replace(/URI="([^"]+)"/g, (_m, inner: string) => {
        const abs = resolveUrl(inner, upstreamBase);
        const blob = absToBlob.get(abs);
        if (blob) return `URI="${blob}"`;
        if (isManifestUrl(abs)) {
          // fallback to fast? Actually for audio fallback to Melana raw if fetch failed
          return `URI="${proxiedManifestRawUrl(abs, noReferrer)}"`;
        }
        return `URI="${fastProxiedUrl(abs, noReferrer)}"`;
      });
      rewrittenMasterLines.push(rewritten);
      nextIsVariant = true;
      continue;
    }

    if (trimmed.startsWith("#")) {
      if (trimmed.startsWith("#EXT-X-KEY")) {
        const uriMatch = rawLine.match(/URI="([^"]+)"/);
        if (uriMatch) {
          const uriVal = uriMatch[1];
          const abs = resolveUrl(uriVal, upstreamBase);
          if (IV_FILE_REGEX.test(abs) || IV_FILE_REGEX.test(uriVal)) {
            let cleaned = rawLine.replace(/,?URI="[^"]*"/, "");
            cleaned = cleaned
              .replace(/,,/g, ",")
              .replace(/:,/g, ":")
              .replace(/,\s*$/, "");
            rewrittenMasterLines.push(cleaned);
            nextIsVariant = false;
            continue;
          }
        }
      }

      const rewritten = rawLine.replace(/URI="([^"]+)"/g, (_m, inner: string) => {
        const abs = resolveUrl(inner, upstreamBase);
        const blob = absToBlob.get(abs);
        if (blob) return `URI="${blob}"`;
        if (isManifestUrl(abs)) {
          return `URI="${proxiedManifestRawUrl(abs, noReferrer)}"`;
        }
        return `URI="${fastProxiedUrl(abs, noReferrer)}"`;
      });
      rewrittenMasterLines.push(rewritten);
      nextIsVariant = false;
      continue;
    }

    // bare URI – variant manifest
    if (nextIsVariant) {
      const abs = resolveUrl(trimmed, upstreamBase);
      const blob = absToBlob.get(abs);
      if (blob) {
        rewrittenMasterLines.push(blob);
      } else {
        // fetch failed – fallback to Melana raw (will still work, just slower)
        rewrittenMasterLines.push(proxiedManifestRawUrl(abs, noReferrer));
      }
    } else {
      // Should not happen in master, but handle as segment just in case
      const abs = resolveUrl(trimmed, upstreamBase);
      rewrittenMasterLines.push(fastProxiedUrl(abs, noReferrer));
    }
    nextIsVariant = false;
  }

  const rewrittenMasterText = rewrittenMasterLines.join("\n");
  const masterBlob = createBlobUrl(rewrittenMasterText);

  return {
    masterBlob,
    variantBlobs,
    allBlobs: [masterBlob, ...variantBlobs],
  };
}

// ---------------------------------------------------------------------------
// Public attach API
// ---------------------------------------------------------------------------

/**
 * Attach a VidCore HLS playlist to a `<video>` element with cross-browser
 * support, using the "raw + fast proxy" optimization.
 *
 * Flow:
 * 1. Master URL is always requested via Melana with `raw=true` – this keeps
 *    VidFast WAF/bypass logic on the server but returns untouched URLs.
 * 2. A custom pLoader rewrites every manifest on the fly:
 *    - variant/audio .m3u8 -> Melana raw=true (still needs bypass)
 *    - segments/keys/subtitles -> Spadik fast proxy (edge, fast)
 * 3. Safari native path builds blob URLs for master+variants with segments
 *    already pointing to Spadik.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  noReferrer: boolean,
  signal?: AbortSignal,
): HlsAttachment | null {
  // Always fetch manifests via Melana raw – fastest if we re-wrap segments
  let upstreamForProxy: string;
  if (isProxiedStreamUrl(playlistUrl)) {
    upstreamForProxy = extractUpstreamUrl(playlistUrl) || playlistUrl;
  } else {
    upstreamForProxy = playlistUrl;
  }
  const sourceUrl = proxiedManifestRawUrl(upstreamForProxy, noReferrer);

  // Safari / iOS play HLS natively – no custom loader support.
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    // Build native blob(s) async – fallback to direct raw url if it fails
    const abortCtrl = new AbortController();
    const onExternalAbort = () => abortCtrl.abort();
    signal?.addEventListener("abort", onExternalAbort, { once: true });

    let nativeResult: NativeBuildResult | null = null;
    let fallbackApplied = false;

    void (async () => {
      try {
        nativeResult = await buildNativeSrc(sourceUrl, noReferrer, abortCtrl.signal);
        if (abortCtrl.signal.aborted) return;
        video.src = nativeResult.masterBlob;
        // video.load() is implicit on src set but explicit for safety
        video.load();
      } catch (e) {
        console.warn("[hls] native blob build failed, fallback to raw proxy", e);
        if (!abortCtrl.signal.aborted && !fallbackApplied) {
          fallbackApplied = true;
          video.src = sourceUrl;
        }
      }
    })();

    return {
      destroy() {
        signal?.removeEventListener("abort", onExternalAbort);
        abortCtrl.abort();
        if (nativeResult) {
          for (const b of nativeResult.allBlobs) {
            try {
              URL.revokeObjectURL(b);
            } catch {}
          }
        }
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (!Hls.isSupported()) {
    return null;
  }

  const RewriteLoader = createRewriteLoader(noReferrer);

  const hls = new Hls({
    pLoader: RewriteLoader as any,
    // Prefer lowest quality on cold start – small segments arrive faster
    startLevel: 0,
    startPosition: 0,
    startFragPrefetch: true,
    maxBufferLength: 12,
    maxMaxBufferLength: 600,
    highBufferWatchdogPeriod: 1.5,
    debug: false,
  });

  hls.attachMedia(video);
  hls.loadSource(sourceUrl);
  hls.startLoad(0);

  hls.on(Hls.Events.ERROR, (_event: any, data: any) => {
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          break;
      }
    }
  });

  const tryPlay = () => {
    if (!video.paused) return;
    void video.play().catch(() => {});
  };

  hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
  hls.on(Hls.Events.LEVEL_LOADED, tryPlay);
  hls.on(Hls.Events.FRAG_BUFFERED, tryPlay);

  const onCanPlay = () => tryPlay();
  video.addEventListener("canplay", onCanPlay, { once: true });
  video.addEventListener("canplaythrough", onCanPlay, { once: true });

  if (video.readyState >= 2) {
    tryPlay();
  }

  return {
    destroy() {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("canplaythrough", onCanPlay);
      hls.destroy();
    },
  };
}
