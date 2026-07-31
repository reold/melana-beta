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
    // Cap the number of parallel segment requests to reduce connection pressure.
    maxBufferLength: 30,
    maxMaxBufferLength: 600,

    // Treat 4xx/5xx responses as errors rather than retrying indefinitely.
    highBufferWatchdogPeriod: 2,

    // Suppress console noise from failed IV/key fetches.
    debug: false,
  });

  // Load the manifest asynchronously and clean it before handing to hls.js.
  let manifestBlobUrl: string | null = null;

  void cleanedManifestUrl(sourceUrl, signal).then(({ display, actual }) => {
    // If the original URL was not proxied, re-wrap the cleaned manifest.
    const loadUrl = isProxiedStreamUrl(display)
      ? actual
      : proxiedStreamUrl(actual, noReferrer);

    // If the manifest is a blob, keep a reference so we can revoke it on destroy.
    if (actual.startsWith("blob:")) {
      manifestBlobUrl = actual;
    }

    // If the blob is being loaded directly, use it as-is.
    // Otherwise use the re-proxied URL.
    hls.loadSource(actual.startsWith("blob:") ? actual : loadUrl);
  });

  hls.attachMedia(video);

  return {
    destroy() {
      if (manifestBlobUrl) {
        URL.revokeObjectURL(manifestBlobUrl);
      }
      hls.destroy();
    },
  };
}
