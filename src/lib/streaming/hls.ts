import Hls from "hls.js";
import {
  extractUpstreamUrl,
  isProxiedStreamUrl,
  proxiedManifestUrl,
} from "./client";

export interface HlsQuality {
  /** hls.js level index */
  id: number;
  label: string;
  height: number;
  bitrate: number;
}

export type HlsQualitySelection = "auto" | number;

export interface HlsAttachOptions {
  /**
   * Start pinned to the lowest advertised rendition. This deliberately avoids
   * an ABR up-switch while the proxy path is still warming up.
   */
  initialQuality?: HlsQualitySelection;
  onQualitiesChange?: (qualities: HlsQuality[]) => void;
  onQualityChange?: (quality: HlsQualitySelection) => void;
  onFatalError?: (message: string) => void;
}

export interface HlsAttachment {
  destroy(): void;
  setQuality(quality: HlsQualitySelection): void;
}

function qualityLabel(level: any, index: number): string {
  if (Number.isFinite(level?.height) && level.height > 0) return `${level.height}p`;
  if (Number.isFinite(level?.width) && level.width > 0) return `${level.width}w`;
  return `Quality ${index + 1}`;
}

/**
 * Attach a unified `/sources` HLS playlist to a `<video>` element with
 * cross-browser support. The per-stream `origin` is forwarded to the
 * manifest proxy so the upstream receives the correct Referer/Origin header.
 *
 * For mp4 streams hls.js is NOT needed – the browser plays the file
 * natively via `video.src = fastProxiedUrl(url, origin)`. This helper
 * should only be called for `type === "hls"` streams (see watch page).
 *
 * Playback intentionally begins on the lowest level rather than immediately
 * using hls.js ABR. Slow proxy starts otherwise cause competing rendition
 * requests and browser-aborted fragments. Users can opt into Auto from the
 * quality control once playback is stable.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  origin: string | null | undefined,
  options: HlsAttachOptions = {},
): HlsAttachment | null {
  let upstreamForProxy: string;
  if (isProxiedStreamUrl(playlistUrl)) {
    upstreamForProxy = extractUpstreamUrl(playlistUrl) || playlistUrl;
  } else {
    upstreamForProxy = playlistUrl;
  }
  // Backward compat: if origin is passed as boolean (legacy noReferrer),
  // coerce to appropriate string handling – string will be used, true => no
  // origin, false => VIDCORE_ORIGIN via buildProxyUrl overload.
  const originParam =
    typeof origin === "string" ? origin : (origin as unknown as boolean);
  const sourceUrl = proxiedManifestUrl(
    upstreamForProxy,
    originParam as string,
  );

  if (!Hls.isSupported()) {
    if (!video.canPlayType("application/vnd.apple.mpegurl")) return null;
    video.src = sourceUrl;
    video.load();
    return {
      setQuality() {
        // Native HLS owns rendition selection; it exposes no portable API.
      },
      destroy() {
        video.removeAttribute("src");
        video.load();
      },
    };
  }

  const hls = new Hls({
    startLevel: 0,
    startPosition: 0,
    startFragPrefetch: true,
    maxBufferLength: 12,
    maxMaxBufferLength: 120,
    highBufferWatchdogPeriod: 1.5,
    debug: false,
  });

  let selectedQuality: HlsQualitySelection = options.initialQuality ?? 0;
  let networkRecoveryAttempts = 0;
  let mediaRecoveryAttempts = 0;
  let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  const setQuality = (quality: HlsQualitySelection) => {
    selectedQuality = quality;
    if (quality === "auto") {
      // -1 hands level choice back to hls.js ABR.
      hls.currentLevel = -1;
      hls.nextLevel = -1;
      hls.loadLevel = -1;
    } else if (hls.levels.length > quality) {
      // Setting all three prevents a pending ABR choice from immediately
      // replacing the user's manual selection.
      hls.currentLevel = quality;
      hls.nextLevel = quality;
      hls.loadLevel = quality;
    }
    options.onQualityChange?.(selectedQuality);
  };

  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    const qualities = hls.levels.map((level: any, id: number) => ({
      id,
      label: qualityLabel(level, id),
      height: Number.isFinite(level.height) ? level.height : 0,
      bitrate: Number.isFinite(level.bitrate) ? level.bitrate : 0,
    }));
    options.onQualitiesChange?.(qualities);

    // A stale index is possible after changing servers; safely fall back to
    // the lowest rendition instead of creating competing level loads.
    if (typeof selectedQuality === "number" && !hls.levels[selectedQuality]) {
      selectedQuality = 0;
    }
    setQuality(selectedQuality);
  });

  hls.on(Hls.Events.LEVEL_SWITCHED, (_event: unknown, data: any) => {
    // Keep the UI truthful when Auto is enabled.
    if (selectedQuality === "auto" && typeof data?.level === "number") {
      options.onQualityChange?.("auto");
    }
  });

  hls.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
    if (!data.fatal || destroyed || recoveryTimer) return;

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // Do not call startLoad repeatedly in the error callback. It creates a
      // request storm against the edge proxy when an upstream fragment stalls.
      if (networkRecoveryAttempts >= 2) {
        options.onFatalError?.("The stream connection failed after two retries.");
        return;
      }
      const delay = networkRecoveryAttempts === 0 ? 1_000 : 3_000;
      networkRecoveryAttempts += 1;
      hls.stopLoad();
      recoveryTimer = setTimeout(() => {
        recoveryTimer = null;
        if (!destroyed) hls.startLoad();
      }, delay);
      return;
    }

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      if (mediaRecoveryAttempts >= 1) {
        options.onFatalError?.("This browser cannot decode the selected stream format.");
        return;
      }
      mediaRecoveryAttempts += 1;
      hls.recoverMediaError();
      return;
    }

    options.onFatalError?.("The video stream could not be loaded.");
  });

  // Keep the previous playback behaviour: begin when the browser has enough
  // media, but never force playback again after a user pause.
  let shouldAutoPlay = true;
  const tryPlay = () => {
    if (!shouldAutoPlay || !video.paused) return;
    void video.play().catch(() => {});
  };
  const stopAutoPlay = () => {
    shouldAutoPlay = false;
  };
  hls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
  hls.on(Hls.Events.LEVEL_LOADED, tryPlay);
  const onCanPlay = () => tryPlay();
  video.addEventListener("canplay", onCanPlay, { once: true });
  video.addEventListener("canplaythrough", onCanPlay, { once: true });
  video.addEventListener("play", stopAutoPlay, { once: true });
  video.addEventListener("pause", stopAutoPlay, { once: true });

  hls.attachMedia(video);
  hls.loadSource(sourceUrl);
  hls.startLoad(0);

  return {
    setQuality,
    destroy() {
      destroyed = true;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      video.removeEventListener("canplay", onCanPlay);
      video.removeEventListener("canplaythrough", onCanPlay);
      video.removeEventListener("play", stopAutoPlay);
      video.removeEventListener("pause", stopAutoPlay);
      hls.destroy();
    },
  };
}
