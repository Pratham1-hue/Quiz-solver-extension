/**
 * Practice Mode controller (blueprint section 3, "Practice Mode flow").
 *
 *   detector --(question visible)--> startAnalysis() --> service worker --> backend --> L1 cache
 *   interceptor --(learner selects)--> read L1 --> verdict rendered in the same frame
 *
 * Evaluation happens HERE from the cached result, so a selection on a prefetched question needs
 * no network round trip at all.
 */
import { send } from '../shared/messages';
import type { AnalysisResult, Priority, QuestionPayload, Session } from '../shared/types';
import { observeQuestions } from './detector';
import { describeBlock, type DescribedQuestion } from './extractor';
import { clearHighlights, mark, playBuzzer } from './feedback';
import { attachInterceptors, type Selection } from './interceptor';
import { captureVisuals } from './vision';

export { setMuted } from './feedback';

export type Verdict = 'correct' | 'incorrect' | 'partial' | 'unknown' | 'pending';

export interface Feedback {
  verdict: Verdict;
  message: string;
  /** error analysis for the option the learner picked (shown behind a "Why?" button) */
  why?: string;
  /** true when the answer was already cached before the learner clicked */
  instant: boolean;
}

export interface PracticeEvents {
  onFeedback(f: Feedback | null): void;
  onError(code: string, message: string): void;
  onProgress(p: { analysing: number; ready: number }): void;
}

interface Entry {
  promise: Promise<AnalysisResult>;
  result?: AnalysisResult;
  visualsMissing: boolean;
  retried: boolean;
}

class AnalysisFailure extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function evaluate(result: AnalysisResult, kind: 'single' | 'multiple' | 'text', selected: string[]): Verdict {
  if (kind === 'text') return 'unknown';
  if (result.needs_more_info || result.off_topic || result.correct_opt_hashes.length === 0) return 'unknown';
  const correct = new Set(result.correct_opt_hashes);
  if (kind === 'single') return correct.has(selected[0]) ? 'correct' : 'incorrect';
  if (selected.some((h) => !correct.has(h))) return 'incorrect';
  return selected.length === correct.size ? 'correct' : 'partial';
}

function isChecked(control: HTMLElement): boolean {
  if (control instanceof HTMLInputElement) return control.checked;
  return control.getAttribute('aria-checked') === 'true';
}

function selectedHashes(q: DescribedQuestion, clicked: Selection['option']): string[] {
  const picked = q.options.filter((o) => isChecked(o.control)).map((o) => o.hash);
  if (q.kind === 'single' && picked.length !== 1 && clicked) {
    // custom cards have no checked state: trust the click
    const c = q.options.find((o) => o.control === clicked.control);
    return c ? [c.hash] : [];
  }
  return picked;
}

/** Normalise typed answers: "$1,000.0" ~ "1000" ~ "1000.00", case/space/punct insensitive. */
export function textMatches(typed: string, answer: string): boolean {
  const norm = (s: string) =>
    s.toLowerCase().replace(/[\s$£€,]/g, '').replace(/\.0+$/, '').replace(/[.:;!?]+$/, '').trim();
  const a = norm(typed);
  const b = norm(answer);
  if (!a || !b) return false;
  if (a === b) return true;
  const num = (s: string) => {
    const n = Number(s.replace(/[%()]/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return Math.abs(na - nb) <= Math.max(0.01, 0.005 * Math.abs(nb));
  return false;
}

function typedValue(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  return el.innerText ?? el.textContent ?? '';
}

async function handleTextAnswer(
  { block, field, typed: typedOverride }: Selection,
  deps: {
    session: Session;
    entries: Map<string, Entry>;
    disposed: () => boolean;
    events: PracticeEvents;
    startAnalysis: (q: DescribedQuestion, priority: 'prefetch' | 'foreground') => Entry;
  },
): Promise<void> {
  if (!field) return;
  const typed = (typedOverride ?? typedValue(field)).trim();
  if (!typed) return; // focus-out without an edit: nothing to check
  if (typed === '—' || /^choose/i.test(typed)) return; // untouched dropdown placeholder
  const q = describeBlock(block);
  if (deps.disposed()) return;
  if (!q) {
    deps.events.onFeedback({ verdict: 'unknown', message: 'I could not read this question on this page, so I cannot check it.', instant: false });
    return;
  }

  let entry = deps.entries.get(q.key);
  const instant = !!entry?.result;
  if (!entry) {
    entry = deps.startAnalysis(q, 'foreground');
    deps.entries.set(q.key, entry);
  }
  if (!entry.result) deps.events.onFeedback({ verdict: 'pending', message: 'Checking your answer…', instant: false });

  let result: AnalysisResult;
  try {
    result = await entry.promise;
  } catch (e) {
    if (!deps.disposed()) {
      const f = e as { code?: string; message?: string };
      deps.events.onError(f.code ?? 'error', f.message ?? String(e));
      deps.events.onFeedback(null);
    }
    return;
  }
  if (deps.disposed()) return;

  const expected = (result.text_answer ?? '').trim();
  if (result.needs_more_info || result.off_topic || !expected) {
    deps.events.onFeedback({
      verdict: 'unknown',
      message: result.off_topic
        ? 'This question looks outside the Subject/Topic you declared, so I will not guess.'
        : 'There is not enough information on the page to check this answer reliably.',
      instant,
    });
    return;
  }

  clearHighlights(block.card);
  if (textMatches(typed, expected)) {
    mark(field, 'ok');
    deps.events.onFeedback({ verdict: 'correct', message: result.explanation_short || 'Correct.', instant });
  } else {
    mark(field, 'bad');
    playBuzzer();
    deps.events.onFeedback({ verdict: 'incorrect', message: `Not quite. The expected answer is: ${expected}`, instant });
  }
}

export function startPractice(session: Session, events: PracticeEvents): () => void {
  let disposed = false;
  let analysing = 0;
  let ready = 0;
  const entries = new Map<string, Entry>();
  const tokens = new WeakMap<HTMLElement, number>();
  let tokenSeq = 0;

  const progress = () => events.onProgress({ analysing, ready });

  function startAnalysis(q: DescribedQuestion, priority: Priority): Entry {
    const entry: Entry = { visualsMissing: false, retried: false, promise: Promise.resolve(null as never) };
    analysing++;
    progress();
    console.info('[Study Agent] analysing', { priority, stem: q.stem.slice(0, 80), options: q.options.map((o) => o.text), kind: q.kind });

    entry.promise = (async () => {
      const shots = await captureVisuals(q.visuals);
      entry.visualsMissing = shots.missing > 0;
      const payload: QuestionPayload = {
        session_id: session.session_id,
        kind: q.kind,
        stem_text: q.stem,
        options: q.options.map((o) => ({ opt_hash: o.hash, text: o.text })),
        latex: q.latex,
        images: shots.images,
        visuals_total: q.visuals.length,
        origin: location.origin,
      };
      const reply = await send<AnalysisResult>({ type: 'ANALYZE', payload, priority });
      if (!reply.ok) throw new AnalysisFailure(reply.code, reply.message);
      entry.result = reply.data;
      ready++;
      return reply.data;
    })()
      .catch((e: unknown) => {
        if (entries.get(q.key) === entry) entries.delete(q.key); // let the next click retry
        const f = e instanceof AnalysisFailure ? e : new AnalysisFailure('error', e instanceof Error ? e.message : String(e));
        // prefetch failures are silent unless the learner can act on them
        if (!disposed && priority === 'prefetch' && ['session_not_found', 'network', 'context_invalidated'].includes(f.code)) {
          events.onError(f.code, f.message);
        }
        throw f;
      })
      .finally(() => {
        analysing--;
        progress();
      });
    entry.promise.catch(() => undefined); // handled at click time; avoid "unhandled rejection" noise
    return entry;
  }

  async function handleSelection({ block, option }: Selection): Promise<void> {
    if (!option) return;
    const q = describeBlock(block);
    if (disposed) return;
    if (!q) {
      // Never show a false "incorrect", but never fail silently either.
      console.info('[Study Agent] could not read this question on this page:', block.card);
      events.onFeedback({ verdict: 'unknown', message: 'I could not read this question on this page, so I cannot check it.', instant: false });
      return;
    }
    console.info('[Study Agent] selection', { stem: q.stem.slice(0, 80), options: q.options.map((o) => o.text), kind: q.kind });

    const selected = selectedHashes(q, option);
    if (selected.length === 0) {
      clearHighlights(block.card);
      events.onFeedback(null);
      return;
    }

    let entry = entries.get(q.key);
    let instant = !!entry?.result;
    // The learner is looking at the question now, so figures that were off-screen at prefetch time can be captured.
    if (entry?.result && entry.visualsMissing && !entry.retried) {
      entry = startAnalysis(q, 'foreground');
      entry.retried = true;
      entries.set(q.key, entry);
      instant = false;
    }
    if (!entry) {
      entry = startAnalysis(q, 'foreground');
      entries.set(q.key, entry);
    }

    const token = ++tokenSeq;
    tokens.set(block.card, token);

    if (!entry.result) {
      clearHighlights(block.card);
      events.onFeedback({ verdict: 'pending', message: 'Checking your answer…', instant: false });
    }

    let result: AnalysisResult;
    try {
      result = await entry.promise;
    } catch (e) {
      if (disposed || tokens.get(block.card) !== token) return;
      const f = e as AnalysisFailure;
      events.onError(f.code ?? 'error', f.message);
      events.onFeedback(null);
      return;
    }
    if (disposed || tokens.get(block.card) !== token) return; // a newer selection superseded this one

    const verdict = evaluate(result, q.kind, selected);
    const byHash = new Map(q.options.map((o) => [o.hash, o]));
    const correct = new Set(result.correct_opt_hashes);
    clearHighlights(block.card);

    switch (verdict) {
      case 'correct':
        selected.forEach((h) => byHash.get(h) && mark(byHash.get(h)!.el, 'ok'));
        events.onFeedback({ verdict, message: result.explanation_short || 'Correct.', instant });
        break;
      case 'incorrect': {
        const wrong = selected.filter((h) => !correct.has(h));
        wrong.forEach((h) => byHash.get(h) && mark(byHash.get(h)!.el, 'bad'));
        playBuzzer();
        const why = wrong.map((h) => result.distractors[h]).filter(Boolean).join(' ');
        events.onFeedback({ verdict, message: 'Not quite. Try again.', why: why || undefined, instant });
        break;
      }
      case 'partial':
        events.onFeedback({ verdict, message: 'On the right track. Select the remaining answer(s).', instant });
        break;
      default:
        events.onFeedback({
          verdict: 'unknown',
          message: result.off_topic
            ? 'This question looks outside the Subject/Topic you declared, so I will not guess.'
            : result.visuals_missing
              ? 'I could not see the figure for this question, so I cannot check it reliably.'
              : 'There is not enough information on the page to check this question.',
          instant,
        });
    }
  }

  const stopDetector = observeQuestions((q) => {
    if (!disposed && !entries.has(q.key)) entries.set(q.key, startAnalysis(q, 'prefetch'));
  });
  const stopInterceptors = attachInterceptors((s) => {
    if (s.field) {
      void handleTextAnswer(s, { session, entries, disposed: () => disposed, events, startAnalysis });
    } else {
      void handleSelection(s);
    }
  });

  return () => {
    disposed = true;
    stopDetector();
    stopInterceptors();
  };
}
