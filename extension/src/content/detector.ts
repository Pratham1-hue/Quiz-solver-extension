/**
 * Speculative detection (blueprint 5.3): notice questions as they approach the viewport and
 * hand them to the practice controller so analysis starts BEFORE the learner clicks.
 */
import { OVERLAY_ID } from '../shared/constants';
import { describeBlock, scanBlocks, type DescribedQuestion } from './extractor';

export function observeQuestions(
  onVisible: (q: DescribedQuestion) => void,
  { dwellMs = 300 }: { dwellMs?: number } = {},
): () => void {
  const timers = new Map<HTMLElement, number>();
  const observed = new Set<HTMLElement>();

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const card = entry.target as HTMLElement;
        const pending = timers.get(card);
        if (pending !== undefined) {
          clearTimeout(pending);
          timers.delete(card);
        }
        if (!entry.isIntersecting) continue; // scrolled away before the dwell time elapsed

        timers.set(
          card,
          window.setTimeout(() => {
            timers.delete(card);
            const block = scanBlocks().find((b) => b.card === card);
            const q = block ? describeBlock(block) : null;
            if (q) onVisible(q);
          }, dwellMs),
        );
      }
    },
    // one extra viewport BELOW = look-ahead for the next question; nothing extra above
    { rootMargin: '0px 0px 100% 0px', threshold: 0.01 },
  );

  const scan = () => {
    for (const card of observed) {
      if (!card.isConnected) {
        io.unobserve(card);
        observed.delete(card);
      }
    }
    for (const block of scanBlocks()) {
      if (!observed.has(block.card)) {
        observed.add(block.card);
        io.observe(block.card);
      }
    }
  };

  // Quizzes are often single-page apps: new questions appear without a page load.
  let scanTimer: number | undefined;
  const mo = new MutationObserver((mutations) => {
    const onlyOverlay = mutations.every((m) => (m.target as Element).closest?.(`#${OVERLAY_ID}`));
    if (onlyOverlay) return;
    clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 400);
  });
  mo.observe(document.body, { childList: true, subtree: true });
  scan();

  return () => {
    io.disconnect();
    mo.disconnect();
    clearTimeout(scanTimer);
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    observed.clear();
  };
}
