import Hls from "hls.js";
import { isProxiedStreamUrl, proxiedStreamUrl } from "./client";

export interface HlsAttachment {
  destroy(): void;
}

/**
 * Attach a VidCore HLS playlist to a `<video>` element with cross-browser
 * support.
 *
 * Only the initial playlist request needs to be sent through the stream proxy.
 * The proxy rewrites the returned HLS manifest so its variant playlists,
 * segments and keys already point back through `/proxy`; hls.js and native HLS
 * can therefore follow those URLs without a custom request loader.
 *
 * Returns `null` when neither MSE-backed playback nor native HLS is available.
 */
export function attachHls(
  video: HTMLVideoElement,
  playlistUrl: string,
  noReferrer: boolean,
): HlsAttachment | null {
  const sourceUrl = isProxiedStreamUrl(playlistUrl)
    ? playlistUrl
    : proxiedStreamUrl(playlistUrl, noReferrer);

  // Safari / iOS play HLS natively. The rewritten manifest ensures all of the
  // media element's subsequent requests continue through the proxy as well.
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

  const hls = new Hls();
  hls.loadSource(sourceUrl);
  hls.attachMedia(video);

  return {
    destroy() {
      hls.destroy();
    },
  };
}
