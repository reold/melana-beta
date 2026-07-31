import Hls from "hls.js";
import { isProxiedStreamUrl, proxiedStreamUrl } from "./client";

export interface HlsAttachment {
  destroy(): void;
}

interface ManifestUrl {
  /** Proxied URL used for display/debugging. */
  display: string;
  /** Blob URL if the manifest was rewritten, otherwise the same as display. */
  actual: string;
}

/** Regular expression that matches IV/key file URLs (`.ico`, `.key`, `.bin`) in segment paths. */
const IV_FILE_REGEX = /\/(480p|720p|1080p|4k)\/[^/]*\.(?:ico|key|bin)(?:\?[^"']*)?$/;

/**
 * Fetch and clean an HLS manifest by removing problematic IV/key file references.
 *
 * Some VidCore manifests reference IV files (`.ico`) that either don't exist or
 * cause CORS/timeout issues when fetched through the proxy. This function:
 *
 * 1. Fetches the raw manifest (through the proxy).
 * 2. Strips IV file URIs from `#EXT-X-KEY` lines — the IV is kept inline.
 * 3. Strips segment-level IV file references.
 * 4. Returns a clean manifest as a Blob URL that HLS.js can load.
 *
 * Falls back to the original URL if the manifest cannot be cleaned.
 */
async function cleanedManifestUrl(
  sourceUrl: string,
  signal?: AbortSignal,
): Promise<ManifestUrl> {
  try {
    const response = await fetch(sourceUrl, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    // Only process `.m3u8` playlists (not master playlists with `#EXT-X-STREAM-INF`).
    if (!text.includes("#EXTM3U") || !text.includes("#EXTINF")) {
      return { display: sourceUrl, actual: sourceUrl };
    }

    // Split into lines for surgical processing.
    const lines = text.split("\n");

    let modified = false;
    const cleanedLines = lines.map((line) => {
      const trimmed = line.trim();

      // Handle #EXT-X-KEY lines with URI pointing to an IV file.
      // Keep the METHOD but strip the broken URI so HLS.js uses only the inline IV.
      const keyMatch = trimmed.match(
        /^(#EXT-X-KEY:)(.*?)(,URI="[^"]*")?(.*)$/,
      );
      if (keyMatch) {
        const [, prefix, method, _uri, remainder] = keyMatch;
        const uriMatch = remainder.match(/,?URI="([^"]*)"/) ?? [];
        const ivMatch = remainder.match(/,?IV=([^,\s]+)/) ?? [];

        const uri = uriMatch[1] ?? "";
        const hasInlineIv = ivMatch.length > 0;

        // If the URI points to an IV file (`.ico`) and there's no inline IV,
        // keep the method but drop the broken URI. HLS.js will use IV=0x0.
        if (uri && IV_FILE_REGEX.test(uri) && !hasInlineIv) {
          modified = true;
          return `${prefix}${method.trim()}`;
        }

        // If the URI is an IV file but there's already an inline IV, just strip URI.
        if (uri && IV_FILE_REGEX.test(uri) && hasInlineIv) {
          modified = true;
          const newRemainder = remainder
            .replace(/,?URI="[^"]*"/, "")
            .replace(/,?\s*,/g, ",")
            .replace(/^,|,$/g, "");
          return `${prefix}${method.trim()}${newRemainder ? "," + newRemainder : ""}`;
        }
      }

      return line;
    });

    if (!modified) {
      return { display: sourceUrl, actual: sourceUrl };
    }

    const cleanedText = cleanedLines.join("\n");
    const blob = new Blob([cleanedText], { type: "application/vnd.apple.mpegurl" });
    const blobUrl = URL.createObjectURL(blob);

    return { display: sourceUrl, actual: blobUrl };
  } catch {
    // Network/parse error — fall back to the original URL.
    return { display: sourceUrl, actual: sourceUrl };
  }
}

/**
 * Attach a VidCore HLS playlist to a `<video>` element with cross-browser
 * support.
 *
 * The initial manifest is fetched through the stream proxy. If the manifest
 * contains problematic IV file references (`.ico`) the manifest is cleaned
 * client-side before being handed to hls.js, avoiding spurious failed requests.
 *
 * Returns `null` when neither MSE-backed playback nor native HLS is available.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  noReferrer: boolean,
  signal?: AbortSignal,
): HlsAttachment | null {
  const sourceUrl = isProxiedStreamUrl(playlistUrl)
    ? playlistUrl
    : proxiedStreamUrl(playlistUrl, noReferrer);

  // Safari / iOS play HLS natively. The rewritten manifest ensures all of the
  // media element's subsequent requests continue through the proxy as well.
  // We cannot clean the manifest for native HLS without a custom media loader,
  // but Safari is less likely to exhibit the `.ico` IV issue.
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = sourceUrl;
    return {
      destroy() {
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  if (!Hls.isSupported()) {
    return null;
  }

  const hls = new Hls({
    // Prefer the lowest quality variant on cold start. Small initial segments
    // arrive faster through a slow/cold proxy, letting us exit the buffering
    // state quickly. hls.js will auto-upswitch as soon as it has bandwidth data.
    startLevel: 0,

    // Start as close to the beginning as possible.
    startPosition: 0,

    // Be eager about the very first fragments.
    startFragPrefetch: true,

    // Reasonable initial buffer target — not too large so we can start playback
    // with the first couple of segments on a slow first fetch.
    maxBufferLength: 12,
    maxMaxBufferLength: 600,

    // Faster reaction to network stalls on first-load cold proxy.
    highBufferWatchdogPeriod: 1.5,

    // Suppress console noise from failed IV/key fetches.
    debug: false,
  });

  // Attach immediately then load the source synchronously.
  // Previously loadSource was inside an async .then() (from manifest cleaner).
  // That artificial delay after <video> mount was the main cause of the player
  // staying in "buffering" forever on the *first* fetch even though the network
  // requests succeeded. hls.js + the media element need to be told the source
  // right away so their state machines advance as soon as bytes arrive.
  hls.attachMedia(video);
  hls.loadSource(sourceUrl);
  // Explicit startLoad guarantees we begin even if any internal autoStartLoad
  // timing is affected by the proxy latency.
  hls.startLoad(0);

  // Background: if the initial playlist (usually master) needs IV cleaning we
  // can hot-reload the cleaned version. Because we already started, this is
  // safe and only affects future segment decisions.
  let manifestBlobUrl: string | null = null;
  void cleanedManifestUrl(sourceUrl, signal).then(({ display, actual }) => {
    if (!actual.startsWith("blob:")) return;

    manifestBlobUrl = actual;
    hls.loadSource(actual);
    hls.startLoad(0);
  });

  // Robust error recovery (helps with transient proxy/cold-origin issues on first fetch).
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) {
      switch (data.type) {
        case Hls.ErrorTypes.NETWORK_ERROR:
          // Many transient first-load proxy hiccups are recovered by restarting the load.
          hls.startLoad();
          break;
        case Hls.ErrorTypes.MEDIA_ERROR:
          hls.recoverMediaError();
          break;
        default:
          // unrecoverable for this session
          break;
      }
    }
  });

  // The key "unstick" for first-load cold proxy case:
  // Even when all manifest + segment files have arrived over the network,
  // the <video> can remain visually buffering because no one has ever
  // successfully called play() after the media was ready.
  // We try on several progressive events. The first successful one wins.
  // All are wrapped so they never throw and never block.
  const tryPlay = () => {
    if (!video.paused) return;
    void video.play().catch(() => {
      /* autoplay policy or user has not yet interacted — that's fine */
    });
  };

  hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
  hls.on(Hls.Events.LEVEL_LOADED, tryPlay);
  hls.on(Hls.Events.FRAG_BUFFERED, tryPlay);

  // Also listen directly on the element in case hls events are late.
  const onCanPlay = () => tryPlay();
  video.addEventListener("canplay", onCanPlay, { once: true });
  video.addEventListener("canplaythrough", onCanPlay, { once: true });

  // If the element already has enough data by the time we get here, kick it.
  if (video.readyState >= 2 /* HAVE_CURRENT_DATA */) {
    tryPlay();
  }

  return {
    destroy() {
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("canplaythrough", onCanPlay);
      if (manifestBlobUrl) {
        URL.revokeObjectURL(manifestBlobUrl);
      }
      hls.destroy();
    },
  };
}
