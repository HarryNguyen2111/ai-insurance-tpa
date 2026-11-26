import { useEffect } from 'react';

/**
 * zmp-ui `AnimationRoutes` wraps each route in a react-transition-group `CSSTransition`
 * (400 ms animated / 200 ms otherwise) and keeps the OUTGOING screen mounted until it finishes.
 * For that window two screens coexist: two <h1>, two "Quay lại" buttons, both focusable and
 * clickable, both in the accessibility tree. A tap or screen-reader action could hit the stale screen.
 *
 * This hook makes the outgoing screen `inert` + `aria-hidden` the moment its exit classes are applied.
 * CSSTransition adds them synchronously in React's commit phase and MutationObserver callbacks run as a
 * microtask right after, so no user event (or test query) can land on the stale screen in between.
 */
import { ITEM_CLASS, ROUTES_SELECTOR, isExitingScreen } from '../lib/screen-transition.ts';

function sync(item: Element): void {
  if (!(item instanceof HTMLElement) || !item.classList.contains(ITEM_CLASS)) return;
  if (isExitingScreen(item.className)) {
    item.inert = true;
    item.setAttribute('aria-hidden', 'true');
  } else if (item.inert) {
    item.inert = false;
    item.removeAttribute('aria-hidden');
  }
}

/** Call from a component that renders <AnimationRoutes> as a descendant (effects run after children mount). */
export function useInertExitingScreens(): void {
  useEffect(() => {
    const container = document.querySelector(ROUTES_SELECTOR);
    if (!container) return;
    Array.from(container.children).forEach(sync);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') {
          if (r.target.parentNode === container) sync(r.target as Element);
        } else {
          r.addedNodes.forEach((n) => n instanceof Element && sync(n));
        }
      }
    });
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
}
