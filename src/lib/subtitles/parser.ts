/**
 * Lightweight SRT / WebVTT subtitle parser.
 *
 * Returns an array of cues with start/end in seconds and raw HTML text.
 * Handles both formats transparently — VTT is a superset of SRT with an
 * optional header line and `.` instead of `,` for milliseconds.
 */

export interface SubtitleCue {
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Text content (HTML-safe after sanitisation). */
  text: string;
}

/**
 * Parse a timestamp line into seconds.
 * Accepts `HH:MM:SS,mmm` (SRT) and `HH:MM:SS.mmm` (VTT), with the hour
 * component optional in VTT.
 */
function parseTimestamp(raw: string): number {
  const parts = raw.trim().split(":");
  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    h = Number(parts[0]);
    m = Number(parts[1]);
    s = Number(parts[2].replace(",", "."));
  } else if (parts.length === 2) {
    m = Number(parts[0]);
    s = Number(parts[1].replace(",", "."));
  } else {
    return 0;
  }
  return h * 3600 + m * 60 + s;
}

/**
 * Strip HTML tags and collapse whitespace — subtitles are rendered as plain
 * text in the overlay, so we don't need to preserve markup. This also
 * neutralises any XSS vectors in community-uploaded files.
 */
function sanitiseText(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, "")
    .replace(/\{[^}]*\}/g, "") // SSA/ASS style tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\r\n/g, "\n")
    .trim();
}

/**
 * Parse an SRT or WebVTT string into an array of cues.
 * Malformed entries are silently skipped so a single bad line doesn't
 * discard the entire file.
 */
export function parseSubtitles(content: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // Normalise line endings and strip the VTT header
  const normalised = content.replace(/\r\n/g, "\n").replace(/^WEBVTT[^\n]*\n/, "");
  // Split on blank lines to get blocks
  const blocks = normalised.split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length < 2) continue;

    // Find the timestamp line (contains " --> ")
    let timestampLineIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timestampLineIndex = i;
        break;
      }
    }
    if (timestampLineIndex === -1) continue;

    const timestampLine = lines[timestampLineIndex];
    const [startStr, endStr] = timestampLine.split("-->");
    if (!startStr || !endStr) continue;

    const start = parseTimestamp(startStr);
    // The end timestamp may have VTT positioning after it — take only the
    // timestamp. Trim first: with the standard ` --> ` (space around the
    // arrow) the segment after "-->" begins with a leading space, so a bare
    // whitespace-split would return "" and collapse the cue end to 0.
    const end = parseTimestamp(endStr.trim().split(/\s+/)[0]);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;

    const textLines = lines.slice(timestampLineIndex + 1);
    const text = sanitiseText(textLines.join("\n"));
    if (!text) continue;

    cues.push({ start, end, text });
  }

  return cues;
}
