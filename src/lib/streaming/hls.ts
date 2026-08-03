import Hls from "hls.js";
import {
  extractUpstreamUrl,
  isProxiedStreamUrl,
  proxiedManifestUrl,
} from "./client";

export interface HlsAttachment {
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Public attach API
// ---------------------------------------------------------------------------

/**
 * Attach a VidCore HLS playlist to a `<video>` element with cross-browser
 * support.
 *
 * The master playlist is fetched through the stream proxy with
 * `proxy=<fast edge base>`: the server handles the VidFast WAF bypass and
 * rewrites every URL in the manifest – variants, audio playlists, segments,
 * keys, subtitles – to the fast edge proxy automatically. No client-side
 * manifest rewriting is needed, so hls.js runs with its default loader.
 *
 * hls.js is preferred on every browser that exposes MediaSource or Apple's
 * ManagedMediaSource — including Safari on macOS/iPadOS and iPhone/iPad on
 * iOS 17.1+. On legacy WebKit builds where hls.js cannot run, the same
 * server-rewritten playlist is handed straight to the native player, since
 * every URL in it already points at the proxy.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  noReferrer: boolean,
): HlsAttachment | null {
  // If the stream service already handed us a proxied URL, unwrap it first so
  // we never wrap a proxy URL in the proxy again.
  let upstreamForProxy: string;
  if (isProxiedStreamUrl(playlistUrl)) {
    upstreamForProxy = extractUpstreamUrl(playlistUrl) || playlistUrl;
  } else {
    upstreamForProxy = playlistUrl;
  }
  const sourceUrl = proxiedManifestUrl(upstreamForProxy, noReferrer);

  // Legacy WebKit builds without MSE/MMS (e.g. iPhone < iOS 17.1): hls.js
  // cannot run, but the server-rewritten playlist is fully self-contained
  // (every URL already points at the proxy), so the native player can consume
  // it directly.
  if (!Hls.isSupported()) {
    if (!video.canPlayType("application/vnd.apple.mpegurl")) return null;
    video.src = sourceUrl;
    video.load();
    return {
      destroy() {
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  const hls = new Hls({
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
