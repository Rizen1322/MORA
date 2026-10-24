// Window placement from saved bounds and the current displays (all in DIP).
// Pure, so monitor changes can be tested without Electron.

const TITLEBAR_H = 40;

/** Clamps a rectangle into a work area, shrinking it when the screen is smaller. */
function fit(r, area) {
  const width = Math.round(Math.min(r.width, area.width));
  const height = Math.round(Math.min(r.height, area.height));
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(r.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(r.y, area.y), area.y + area.height - height)),
  };
}

/**
 * Saved bounds stay where they were only while a usable part of the title bar
 * is on some display; otherwise the window is centred on the nearest display
 * (for example after a monitor was unplugged). No saved bounds: default size,
 * centred on the primary display.
 */
export function placeWindow(saved, workAreas, primary, size = { width: 1280, height: 820 }) {
  const ok = saved && [saved.x, saved.y, saved.width, saved.height].every(Number.isFinite) && saved.width > 0 && saved.height > 0;
  if (ok) {
    const visible = workAreas.find((a) =>
      Math.min(saved.x + saved.width, a.x + a.width) - Math.max(saved.x, a.x) >= 120 &&
      saved.y >= a.y - 8 && saved.y + TITLEBAR_H <= a.y + a.height);
    if (visible) return fit(saved, visible);
    const nearest = workAreas.reduce((best, a) => {
      const d = Math.hypot(a.x + a.width / 2 - (saved.x + saved.width / 2), a.y + a.height / 2 - (saved.y + saved.height / 2));
      return d < best.d ? { a, d } : best;
    }, { a: primary, d: Infinity }).a;
    return fit({ ...saved, x: nearest.x + (nearest.width - saved.width) / 2, y: nearest.y + (nearest.height - saved.height) / 2 }, nearest);
  }
  return fit({ ...size, x: primary.x + (primary.width - size.width) / 2, y: primary.y + (primary.height - size.height) / 2 }, primary);
}
