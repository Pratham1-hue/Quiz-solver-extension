/**
 * Answer Mode executor: walks the page top to bottom, reads every question,
 * gets an answer from the backend, then performs the clicks/typing itself.
 *
 * Hard limits (from the blueprint): synchronous, sequential, stoppable at any time
 * (Stop button, Esc, navigation), and every injected event is untrusted so it can
 * never trigger the Practice-mode tutoring.
 */
import { describeBlock, scanBlocks, type DescribedQuestion } from './extractor';
import { captureVisuals } from './vision';
import { send } from '../shared/messages';
import { textMatches } from './practice';
import type { AnalysisResult, QuestionPayload, Session } from '../shared/types';

function isDropdownField(el: HTMLElement): boolean {
  const role = el.getAttribute('role');
  return role === 'listbox' || role === 'combobox' || el.hasAttribute('aria-haspopup') || el.tagName === 'SELECT';
}

function optionMatches(optEl: Element, answer: string): boolean {
  const t = ((optEl instanceof HTMLElement ? optEl.innerText : optEl.textContent) || '').trim();
  if (!t) return false;
  return textMatches(t, answer) || t.toLowerCase().includes(answer.toLowerCase()) || answer.toLowerCase().includes(t.toLowerCase());
}

function visibleOptions(): Element[] {
  return [...document.querySelectorAll('[role="option"]')].filter((el) => el.getClientRects().length > 0);
}

export interface AutoEvents {
  onStatus(message: string): void;
  onDone(message: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fireClick(el: HTMLElement): void {
  const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

function setNativeValue(el: HTMLElement, value: string): void {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else (el as HTMLInputElement).value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  // contenteditable / role=textbox
  el.focus();
  el.innerText = value;
  el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function isChecked(control: HTMLElement): boolean {
  if (control instanceof HTMLInputElement) return control.checked;
  return control.getAttribute('aria-checked') === 'true';
}

async function analyze(q: DescribedQuestion, session: Session, events: AutoEvents): Promise<AnalysisResult | null> {
  const shots = await captureVisuals(q.visuals);
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
  const reply = await send<AnalysisResult>({ type: 'ANALYZE', payload, priority: 'foreground' });
  if (!reply.ok) {
    console.warn('[Study Agent] analyze failed:', reply.code, reply.message);
    events.onStatus(`Could not solve: ${q.stem.slice(0, 40)}… (${reply.code}: ${reply.message})`);
    return null;
  }
  return reply.data;
}

/** Apply one question's analysis to the page. Returns true if something was written. */
async function answerQuestion(q: DescribedQuestion, result: AnalysisResult): Promise<boolean> {
  if (q.kind === 'text') {
    const field = q.fields[0];
    const value = (result.text_answer ?? '').trim();
    if (!field || !value) return false;
    field.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(500);

    // Dropdown: click to open, then click the matching option. A native <select> is
    // just written directly and changed.
    if (field instanceof HTMLSelectElement) {
      const opt = [...field.options].find((o) => optionMatches(o, value));
      if (!opt) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (setter) setter.call(field, opt.value);
      field.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (isDropdownField(field)) {
      fireClick(field);
      await sleep(600); // let the menu open and populate [role=option]
      let opts = visibleOptions();
      if (opts.length === 0) {
        // the actual trigger is often a deep child (the visible "Choose"/value tile)
        const triggers = [...field.querySelectorAll<HTMLElement>('div, span, button, [tabindex], [role="combobox"], [role="button"]')]
          .filter((e) => e.getClientRects().length > 0)
          .sort((a, b) => (a.innerText?.length ?? 1e9) - (b.innerText?.length ?? 1e9));
        for (const t of triggers.slice(0, 8)) {
          fireClick(t);
          await sleep(400);
          opts = visibleOptions();
          if (opts.length > 0) break;
        }
      }
      if (opts.length === 0) {
        console.warn('[Study Agent] dropdown never opened for', value);
        return false;
      }
      const match = opts.find((o) => optionMatches(o, value));
      if (!match) {
        console.warn('[Study Agent] no dropdown option matched', value, opts.map((o) => (o as HTMLElement).innerText?.trim()));
        fireClick(document.body); // close the menu we just opened so the outer loop isn't stuck
        await sleep(300);
        return false;
      }
      (match as HTMLElement).scrollIntoView({ block: 'center' });
      await sleep(300);
      fireClick(match as HTMLElement);
      await sleep(300);
      return true;
    }

    field.focus();
    setNativeValue(field, value);
    field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    return true;
  }

  const correct = new Set(result.correct_opt_hashes);
  if (correct.size === 0) return false;
  let done = false;
  for (const opt of q.options) {
    const shouldBe = correct.has(opt.hash);
    const checked = isChecked(opt.control);
    if (checked && shouldBe) done = true; // already in the desired state
    if ((q.kind === 'single' && !shouldBe) || (!shouldBe && !checked)) continue;
    if (q.kind === 'multiple' && checked === shouldBe) {
      if (shouldBe) done = true;
      continue;
    }
    if (shouldBe && !checked) {
      opt.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(500);
      fireClick(opt.control);
      done = true;
      await sleep(450); // let the page record the choice
    } else if (q.kind === 'multiple' && checked && !shouldBe) {
      opt.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(400);
      fireClick(opt.control); // deselect a wrong pre-existing tick
      done = true;
      await sleep(400);
    }
  }
  return done;
}

export function autoSolve(session: Session, events: AutoEvents): () => void {
  let stop = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') stop = true;
  };
  document.addEventListener('keydown', onKey, true);

  void (async () => {
    const seen = new Set<string>(); // question keys we already answered (or tried)
    let idlePasses = 0;
    let answered = 0;

    try {
      for (let guard = 0; guard < 60 && !stop; guard++) {
        const blocks = scanBlocks();
        let newWork = false;

        for (const block of blocks) {
          if (stop) break;
          const q = describeBlock(block);
          if (!q || seen.has(q.key)) continue;
          seen.add(q.key);
          newWork = true;

          // make sure both the stem and the answer control are on screen
          block.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          await sleep(400);

          events.onStatus(`Solving (${answered + 1}): ${q.stem.slice(0, 60)}…`);
          const result = await analyze(q, session, events);
          if (!result) continue;
          const wrote = await answerQuestion(q, result);
          if (wrote) {
            answered++;
            events.onStatus(`Answered ${answered}: ${q.stem.slice(0, 60)}…`);
          }
          await sleep(600);
        }

        if (stop) break;

        // scroll one viewport; if we stay at the bottom with no new questions twice, we're done
        const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 8;
        const before = window.scrollY;
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: 'smooth' });
        await sleep(700);
        const moved = window.scrollY > before + 4;
        idlePasses = !moved && atBottom && !newWork ? idlePasses + 1 : 0;
        if (idlePasses >= 2) break;
      }
      events.onDone(stop ? 'Stopped.' : `Finished. Filled in ${answered} question(s). Review the answers, then submit.`);
    } finally {
      document.removeEventListener('keydown', onKey, true);
    }
  })();

  return () => {
    stop = true;
  };
}
