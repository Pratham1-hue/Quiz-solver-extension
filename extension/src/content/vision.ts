/**
 * Visual handling (blueprint 4.4): find figures that carry information, then capture them
 * through the service worker (chrome.tabs.captureVisibleTab + crop).
 */
import { OVERLAY_ID } from '../shared/constants';
import { send } from '../shared/messages';
import type { CapturedImage } from '../shared/types';

const VISUAL = 'img, svg, canvas';
const NOT_A_FIGURE =
  `#${OVERLAY_ID}, button, .katex, mjx-container, [class*="MathJax"], [aria-hidden="true"], ` +
  'img[data-equation-content], img.equation_image';

/** Informative visuals inside a question card: big enough, visible, and not an icon or an equation. */
export function pickVisuals(card: HTMLElement, max = 3): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of card.querySelectorAll<HTMLElement>(VISUAL)) {
    if (el.closest(NOT_A_FIGURE)) continue;
    if (el.parentElement?.closest('svg')) continue; // nested inside another svg
    const r = el.getBoundingClientRect();
    if (r.width < 48 || r.height < 32) continue; // icons, radio-button art, spacers
    if (getComputedStyle(el).visibility === 'hidden') continue;
    out.push(el);
    if (out.length >= max) break;
  }
  return out;
}

export function isFullyVisible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
}

function captionFor(el: Element): string {
  const c =
    el.getAttribute('alt') ||
    el.getAttribute('aria-label') ||
    el.closest('figure')?.querySelector('figcaption')?.textContent ||
    '';
  return c.replace(/\s+/g, ' ').trim().slice(0, 200);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** rAF does not fire in background tabs, so never wait on it alone. */
const nextFrame = () => Promise.race([new Promise<void>((r) => requestAnimationFrame(() => r())), sleep(100)]);

export interface CaptureResult {
  images: CapturedImage[];
  /** visuals we could not capture (not fully on screen, tab hidden, capture failed) */
  missing: number;
}

/**
 * Captures only elements that are fully inside the viewport. It never scrolls the page:
 * prefetching must stay invisible to the learner.
 */
export async function captureVisuals(els: HTMLElement[]): Promise<CaptureResult> {
  if (!els.length) return { images: [], missing: 0 };
  if (document.visibilityState !== 'visible') return { images: [], missing: els.length };

  const visible = els.filter(isFullyVisible);
  let missing = els.length - visible.length;
  const images: CapturedImage[] = [];
  if (!visible.length) return { images, missing };

  // Keep our own overlay out of the screenshot.
  const host = document.getElementById(OVERLAY_ID);
  const previous = host?.style.visibility ?? '';
  if (host) host.style.visibility = 'hidden';
  try {
    await nextFrame();
    for (const [i, el] of visible.entries()) {
      const r = el.getBoundingClientRect();
      const reply = await send<{ mime: string; data_b64: string }>({
        type: 'CAPTURE_RECT',
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        dpr: window.devicePixelRatio || 1,
      });
      if (reply.ok) {
        images.push({ image_id: `img${i + 1}`, mime: reply.data.mime, data_b64: reply.data.data_b64, caption: captionFor(el) });
      } else {
        missing++;
      }
    }
  } finally {
    if (host) host.style.visibility = previous;
  }
  return { images, missing };
}
