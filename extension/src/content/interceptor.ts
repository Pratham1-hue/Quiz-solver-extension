/**
 * Practice-mode event interception (blueprint 4.5).
 *
 * - Capture-phase listeners that only OBSERVE: they never block or alter the page.
 * - Native radios/checkboxes are reported through `change` (fires exactly once per real change;
 *   the old `click` handler fired twice for every <label> click).
 * - ARIA / custom option cards (Google Forms, MUI, ...) have no native input, so they are
 *   reported through `click`, even when they sit inside a <label>. We then wait for the page to
 *   flip `aria-checked` before reading the selection.
 * - Synthetic events (isTrusted === false) are ignored, so the future Answer-Mode executor
 *   cannot trigger tutoring feedback.
 */
import { OVERLAY_ID } from '../shared/constants';
import { findField, type OptionRef, type QuestionBlock } from './extractor';

export interface Selection {
  block: QuestionBlock;
  /** set when the learner toggled an option; null for free-text answers */
  option: OptionRef | null;
  /** set when the learner edited a free-text answer control */
  field: HTMLElement | null;
  /** the option's label for dropdown selections (the field's live text cannot be trusted then) */
  typed?: string;
}

const isNativeChoice = (el: unknown): el is HTMLInputElement =>
  el instanceof HTMLInputElement && (el.type === 'radio' || el.type === 'checkbox');

const TEXTISH = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', '']);

function isFreeText(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXTISH.has(el.type);
  if ((el as HTMLElement).isContentEditable) return true;
  return el.getAttribute('role') === 'textbox';
}

/** Resolves once the control's aria-checked changes (the page handles the click a few ms later), or after a timeout. */
function afterStateSettles(control: HTMLElement, timeoutMs = 400): Promise<void> {
  const before = control.getAttribute('aria-checked');
  if (before === null) return new Promise((r) => setTimeout(r, 60)); // custom cards expose no state
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      mo.disconnect();
      clearTimeout(timer);
      setTimeout(resolve, 20); // let sibling options finish updating too
    };
    const mo = new MutationObserver(() => {
      if (control.getAttribute('aria-checked') !== before) done();
    });
    mo.observe(control, { attributes: true, attributeFilter: ['aria-checked'] });
    timer = window.setTimeout(done, timeoutMs); // e.g. re-clicking the already selected radio changes nothing
  });
}

export function attachInterceptors(onSelect: (s: Selection) => void): () => void {
  const handler = (ev: Event) => {
    if (!ev.isTrusted) return;
    const path = ev.composedPath();
    if (path.some((n) => n instanceof Element && n.id === OVERLAY_ID)) return; // our own UI
    const target = path[0];
    if (!(target instanceof Element)) return;

    if (ev.type === 'click' && (isNativeChoice(target) || isNativeChoice(target.closest('label')?.control))) return;
    // A click that will toggle a NATIVE input is reported through `change`. Anything else is ours,
    // including clicks inside a <label> that wraps an ARIA control (no native input => no `change`).

    const block = findField(target);
    if (!block) return;

    if (ev.type === 'change' || ev.type === 'focusout') {
      if (block.kind === 'text' && isFreeText(target)) {
        onSelect({ block, option: null, field: target as HTMLElement });
        return;
      }
      if (ev.type === 'change' && isNativeChoice(target)) {
        const option = block.options.find((o) => o.control === target);
        if (option) onSelect({ block, option, field: null });
      }
      return;
    }

    // click: only option controls (ARIA/custom cards); text fields report on change/focusout.
    // An ARIA option click usually belongs to an open dropdown: treat it as a text answer.
    const optEl = target.closest('[role="option"]');
    if (optEl && block.kind === 'text') {
      const field = block.fields[0] ?? (optEl as HTMLElement);
      onSelect({ block, option: null, field: field as HTMLElement, typed: ((optEl as HTMLElement).innerText || optEl.textContent || '').trim() });
      return;
    }
    if (isNativeChoice(target) || isNativeChoice(target.closest('label')?.control)) return;
    const option = block.options.find((o) => o.control === target || o.el.contains(target) || o.control.contains(target));
    if (!option) return;
    void afterStateSettles(option.control).then(() => onSelect({ block, option, field: null }));
  };

  document.addEventListener('change', handler, true);
  document.addEventListener('click', handler, true);
  document.addEventListener('focusout', handler, true);
  return () => {
    document.removeEventListener('change', handler, true);
    document.removeEventListener('click', handler, true);
    document.removeEventListener('focusout', handler, true);
  };
}
