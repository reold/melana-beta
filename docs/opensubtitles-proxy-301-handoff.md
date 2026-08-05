# OpenSubtitles proxy: frontend 301 handoff

The browser calls the documented proxy endpoint only:

```text
GET {PUBLIC_STREAM_PROXY_ORIGIN}/opensubtitles/subtitles?tmdb_id=<id>&languages=<code>&order_by=download_count
```

It sends no OpenSubtitles API key and makes no direct request to `api.opensubtitles.com` or the subtitle CDN. The frontend received a terminal `301 Moved Permanently` with an HTML body from that proxy request, so it could not parse the expected upstream JSON.

Browser `fetch` uses `redirect: "follow"` by default. Seeing a `301` in the application therefore points to the proxy (or its upstream client) returning/forwarding a redirect rather than resolving it server-side. This is not a frontend CORS or API-key issue.

Please make the proxy contract deterministic:

1. `GET /opensubtitles/subtitles` must return `200 application/json` (the OpenSubtitles JSON payload), never an HTML redirect.
2. Use the canonical upstream URL `https://api.opensubtitles.com/api/v1/subtitles` and have the backend HTTP client follow any upstream redirects before responding.
3. Preserve CORS headers on the final response.
4. `POST /opensubtitles/download` must return a proxy-wrapped link at `/opensubtitles/file?url=...`; the frontend intentionally rejects a direct CDN link so subtitle file traffic stays CORS-safe and proxied.
