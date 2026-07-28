import Hls, {
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from "hls.js";
import { isProxiedStreamUrl, proxiedStreamUrl } from "./client";

export interface HlsAttachment {
  destroy(): void;
}

/**
 * Attach a Vidfast HLS playlist to a `<video>` element with cross-browser
 * support.
 *
 * Every playlist, segment and key request is funnelled through the stream proxy
 * so the provider's required origin/referrer is supplied and CORS is satisfied
 * for the browser. Safari and iOS use their built-in HLS engine instead, in
 * which case only the playlist URL is proxied.
 *
 * Returns `null` when neither MSE-backed playback nor native HLS is available.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  noReferrer: boolean,
): HlsAttachment | null {
  // Safari / iOS play HLS natively. Media-element playback does not require
  // CORS, but routing through the proxy keeps the referrer correct.
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = proxiedStreamUrl(playlistUrl, noReferrer);
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
    // Rewrite every request through the stream proxy unless it already is.
    loader: buildProxyLoader(noReferrer),
  });

  hls.loadSource(playlistUrl);
  hls.attachMedia(video);

  return {
    destroy() {
      hls.destroy();
    },
  };
}

function buildProxyLoader(noReferrer: boolean) {
  // Subclass the configured default loader (XHR or Fetch) so retries, stats and
  // progress reporting keep working — only the request URL is rewritten.
  const BaseLoader = Hls.DefaultConfig.loader;
  return class extends BaseLoader {
    load(
      context: LoaderContext,
      config: LoaderConfiguration,
      callbacks: LoaderCallbacks<LoaderContext>,
    ): void {
      if (context.url && !isProxiedStreamUrl(context.url)) {
        context.url = proxiedStreamUrl(context.url, noReferrer);
      }
      super.load(context, config, callbacks);
    }
  };
}
