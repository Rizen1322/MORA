import { useLayoutEffect, type RefObject } from 'react';

/** FLIP moving blocks rather than scaling text or animating the whole audio UI. */
export function usePlayerLayout(root: RefObject<HTMLDivElement | null>, reduced: boolean) {
  useLayoutEffect(() => {
    const body = root.current?.querySelector('.fp-body');
    if (!body) return;
    const previous = new Map<Element, DOMRect>();
    const animations = new Map<Element, Animation>();
    const update = () => {
      const elements = body.querySelectorAll<HTMLElement>('.fp-art-stage, .fp-track-heading > *, .fp-info > :not(.fp-track-heading)');
      for (const element of previous.keys()) if (!body.contains(element)) { previous.delete(element); animations.get(element)?.cancel(); animations.delete(element); }
      for (const element of elements) {
        const old = previous.get(element);
        const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform);
        animations.get(element)?.cancel();
        const next = element.getBoundingClientRect();
        previous.set(element, next);
        if (!reduced && old) {
          const x = old.x + transform.m41 - next.x, y = old.y + transform.m42 - next.y;
          if (Math.abs(x) + Math.abs(y) > 0.5) {
            const animation = element.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: 'translate(0, 0)' }], { duration: 440, easing: 'cubic-bezier(.22, 1, .36, 1)' });
            animations.set(element, animation);
          }
        }
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(body);
    for (const element of body.querySelectorAll('.fp-info, .fp-track-heading, .fp-title, .fp-artist')) observer.observe(element);
    return () => { observer.disconnect(); for (const animation of animations.values()) animation.cancel(); };
  }, [root, reduced]);
}
