import { useMemo } from 'react';

export type RowAction = 'next' | 'queue';
export interface RowHandlers { tap: () => void; hold: (row: HTMLElement) => void; swipe: (a: RowAction) => void }

/** Past this distance a released row commits: right plays next, left adds to the queue. */
export const ROW_COMMIT = 96;
const LIMIT = 110;

/** The row follows the finger 1:1 up to LIMIT, then with resistance (rubber band). */
export function rowOffset(dx: number): number {
  const ax = Math.abs(dx);
  return ax <= LIMIT ? dx : Math.sign(dx) * (LIMIT + (ax - LIMIT) * 0.45);
}

export function rowAction(offset: number): RowAction | null {
  return offset >= ROW_COMMIT ? 'next' : offset <= -ROW_COMMIT ? 'queue' : null;
}

/**
 * iPhone track rows: tap plays, a horizontal swipe queues, a long press opens the menu.
 * The offset goes straight into --dx on the row (no React render per move); vertical
 * movement is left to native scrolling (touch-action: pan-y in mobile.css).
 */
export function useRowGesture() {
  return useMemo(() => {
    let s: { x: number; y: number; row: HTMLElement; mode: 'x' | 'y' | null; dx: number; held: boolean; onButton: boolean; timer: number } | null = null;
    const settle = (row: HTMLElement) => {
      row.classList.remove('swiping', 'armed');
      row.style.removeProperty('--dx');
    };
    return (on: RowHandlers) => ({
      onTouchStart: (e: React.TouchEvent<HTMLElement>) => {
        if (s) clearTimeout(s.timer);
        if (e.touches.length !== 1) { s = null; return; }
        const p = e.touches[0];
        const cur: NonNullable<typeof s> = { x: p.clientX, y: p.clientY, row: e.currentTarget, mode: null, dx: 0, held: false, onButton: !!(e.target as HTMLElement).closest('button, a'), timer: 0 };
        cur.timer = window.setTimeout(() => { cur.held = true; on.hold(cur.row); }, 450);
        s = cur;
      },
      onTouchMove: (e: React.TouchEvent<HTMLElement>) => {
        if (!s) return;
        const p = e.touches[0], mx = p.clientX - s.x, my = p.clientY - s.y;
        if (!s.mode && Math.hypot(mx, my) > 8) {
          clearTimeout(s.timer);
          s.mode = Math.abs(mx) > Math.abs(my) ? 'x' : 'y';
          if (s.mode === 'x') s.row.classList.add('swiping');
        }
        if (s.mode !== 'x') return;
        s.dx = rowOffset(mx);
        s.row.style.setProperty('--dx', `${s.dx}px`);
        s.row.dataset.swipe = s.dx < 0 ? 'queue' : 'next';
        s.row.classList.toggle('armed', rowAction(s.dx) !== null);
      },
      onTouchEnd: (e: React.TouchEvent<HTMLElement>) => {
        const cur = s;
        s = null;
        if (!cur) return;
        clearTimeout(cur.timer);
        settle(cur.row);
        if (cur.mode === 'x') {
          e.preventDefault(); // no click after a swipe
          const a = rowAction(cur.dx);
          if (a) on.swipe(a);
        } else if (cur.held) e.preventDefault();
        else if (!cur.mode && !cur.onButton) on.tap();
      },
      onTouchCancel: () => {
        if (!s) return;
        clearTimeout(s.timer);
        settle(s.row);
        s = null;
      },
    });
  }, []);
}
