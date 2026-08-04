/**
 * Document scroll helpers that survive iOS body-scroll locking.
 *
 * iOS Safari ignores `overflow: hidden` on `<body>`, so every scroll-lock
 * implementation (including the one inside the details sheet) parks the page
 * with `position: fixed; top: -<scrollY>px`. While that lock is held
 * `window.scrollY` reads 0 and `scrollTo()` does nothing, which would otherwise
 * make us snapshot — and restore — the wrong position whenever a sheet is open.
 */

function lockedScrollY(): number | null {
  const { style } = document.body;
  if (style.position !== "fixed" || !style.top) return null;

  const top = Number.parseFloat(style.top);
  return Number.isFinite(top) && top <= 0 ? -top : null;
}

/** The page's scroll offset, including while the body is locked. */
export function readPageScrollY(): number {
  if (typeof document === "undefined") return 0;
  return lockedScrollY() ?? window.scrollY;
}

/**
 * Restores a scroll offset. When the body is locked the offset is written to
 * the lock itself, so the page is in the right place once it is released.
 */
export function restorePageScrollY(y: number) {
  if (typeof document === "undefined") return;
  const target = Math.max(0, Math.round(y));

  if (lockedScrollY() !== null) {
    document.body.style.top = `-${target}px`;
    return;
  }

  window.scrollTo(0, target);
}
