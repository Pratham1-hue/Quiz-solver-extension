/**
 * Question discovery and extraction (blueprint 4.2).
 *
 * ONE implementation is shared by the prefetch path (detector) and the click path (interceptor),
 * so both always derive the same stem, options and cache key for a given question.
 *
 * Strategy: find groups of answer controls first (radio / checkbox / ARIA / "option" cards), then
 * climb from the group to the smallest ancestor that also contains the stem text. This avoids
 * the old approach of treating every <div> with two <label>s as a "question".
 */
import { OVERLAY_ID } from '../shared/constants';
import { hash53, normalizeText } from '../shared/hash';
import type { QuestionKind } from '../shared/types';
import { isMathJaxV2Output, isMathScript, isMathScriptDisplay, mathFromElement } from './math';
import { pickVisuals } from './vision';

const NATIVE = 'input[type="radio"], input[type="checkbox"]';
const ARIA = '[role="radio"], [role="checkbox"]';
const CUSTOM = '[class*="option" i], [class*="choice" i]';
/** Free-text answer controls: short answer, paragraph, number, date, ... */
const TEXT = [
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input[type="url"]',
  'input[type="tel"]',
  'input[type="number"]',
  'input[type="date"]',
  'input[type="datetime-local"]',
  'input:not([type])',
  'textarea',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[role="textbox"]',
  // dropdowns (Google Forms "Dropdown") behave like a free-text question whose
  // answer must be one of the listed options: the field reports its selected option text
  '[role="listbox"]',
  '[aria-haspopup="listbox"]',
  '[role="combobox"]',
].join(', ');
const EXCLUDED = 'nav, header, footer, select, [role="menu"], [role="menuitem"], [role="tab"]';
/** Page-provided feedback/solutions must never leak into the stem (it would change the cache key). */
const FEEDBACK = '[role="alert"], [class*="feedback" i], [class*="explanation" i], [class*="solution" i]';

export interface OptionRef {
  /** element to highlight / read text from (the option "row") */
  el: HTMLElement;
  /** the actual control: <input>, [role=radio], or the card itself */
  control: HTMLElement;
  /** native <input>: reported through `change`; otherwise through `click` */
  native: boolean;
}

export interface QuestionBlock {
  card: HTMLElement;
  kind: QuestionKind;
  options: OptionRef[];
  /** free-text answer controls (kind === 'text'); empty otherwise */
  fields: HTMLElement[];
}

export interface DescribedOption extends OptionRef {
  text: string;
  /** identity of the option = hash of its content, NOT its position (pages shuffle options) */
  hash: string;
}

export interface DescribedQuestion {
  /** stable client-side key: same question => same key, whatever the option order */
  key: string;
  block: QuestionBlock;
  kind: QuestionKind;
  stem: string;
  options: DescribedOption[];
  /** free-text answer controls (kind === 'text') */
  fields: HTMLElement[];
  latex: string[];
  visuals: HTMLElement[];
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const uids = new WeakMap<object, number>();
let nextUid = 1;
const uid = (o: object): number => {
  let v = uids.get(o);
  if (v === undefined) {
    v = nextUid++;
    uids.set(o, v);
  }
  return v;
};

const isRendered = (el: Element): boolean => el.getClientRects().length > 0;
const visibleLength = (el: HTMLElement): number => (el.innerText ?? el.textContent ?? '').replace(/\s+/g, '').length;
const hasAncestorIn = (el: Element, set: Set<Element>): boolean => {
  for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
  return false;
};

/** The "row" to highlight for a control. Native inputs climb while the parent holds only this one control. */
function optionElementFor(control: HTMLElement, controls: HTMLElement[]): HTMLElement {
  // Climb for every control kind: with ARIA widgets (Google Forms, MUI, ...) the visible text sits in a
  // SIBLING of the role="radio" element, so the row must include it.
  let el: HTMLElement = control;
  while (el.parentElement && el.parentElement !== document.body) {
    const parent = el.parentElement;
    if (controls.filter((c) => parent.contains(c)).length !== 1) break;
    el = parent;
  }
  // input and label are direct siblings: use the label (it has the text and is visible)
  if (el === control && control instanceof HTMLInputElement) {
    const label = (control as HTMLInputElement).labels?.[0];
    if (label) return label;
  }
  return el;
}

const STEM_HINT = '[role="heading"], h1, h2, h3, h4, h5, h6, legend';
const BUTTONS = 'button, [role="button"]';

function hasStemText(candidate: HTMLElement, optionEls: HTMLElement[]): boolean {
  const outside = (el: Element) => !optionEls.some((o) => o.contains(el));
  // a heading outside the options is the strongest sign that we reached the question
  if ([...candidate.querySelectorAll(STEM_HINT)].some(outside)) return true;
  const inOptions = optionEls.reduce((n, o) => n + (candidate.contains(o) ? visibleLength(o) : 0), 0);
  // "Clear selection" / "Check" are controls, not question text
  const inButtons = [...candidate.querySelectorAll<HTMLElement>(BUTTONS)].filter(outside).reduce((n, b) => n + visibleLength(b), 0);
  return visibleLength(candidate) - inOptions - inButtons >= 8;
}

/** Smallest ancestor that contains all options and some stem text, without swallowing another question. */
function findCard(optionEls: HTMLElement[], otherOptionEls: HTMLElement[]): HTMLElement | null {
  let a: HTMLElement | null = optionEls[0].parentElement;
  while (a && !optionEls.every((o) => a!.contains(o))) a = a.parentElement;
  if (!a) return null;
  for (let i = 0; i < 6; i++) {
    if (hasStemText(a, optionEls)) break;
    const parent: HTMLElement | null = a.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) break;
    if (otherOptionEls.some((o) => parent.contains(o))) break;
    a = parent;
  }
  return a;
}

// ---------------------------------------------------------------------------
// discovery
// ---------------------------------------------------------------------------
export function scanBlocks(): QuestionBlock[] {
  interface Group {
    kind: QuestionKind;
    native: boolean;
    controls: HTMLElement[];
  }
  const groups = new Map<string, Group>();
  const add = (key: string, kind: QuestionKind, native: boolean, control: HTMLElement) => {
    let g = groups.get(key);
    if (!g) {
      g = { kind, native, controls: [] };
      groups.set(key, g);
    }
    g.controls.push(control);
  };

  /**
   * Smallest ancestor of `el` that also contains another control matching `sel`.
   * ARIA options on Google Forms/MUI live in per-option wrappers, so `parentElement`
   * alone never yields a group; climbing until we see the whole option list fixes grouping
   * without merging neighbouring questions (each question keeps its own option list).
   */
  const containerOf = (el: HTMLElement, sel: string): Element => {
    let box: HTMLElement | null = el.parentElement;
    while (box && box !== document.body && box !== document.documentElement) {
      if (box.querySelectorAll(sel).length >= 2) return box;
      box = box.parentElement;
    }
    return el.parentElement ?? document.body;
  };

  // 1. native radios / checkboxes. Radios group by name (per form); everything else by shared container.
  for (const input of document.querySelectorAll<HTMLInputElement>(NATIVE)) {
    if (input.closest(EXCLUDED)) continue;
    const radio = input.type === 'radio';
    if (radio && input.name) {
      const scope = input.form ? uid(input.form) : 0;
      add(`r:${scope}:${input.name}`, 'single', true, input);
    } else {
      const sel = radio ? 'input[type="radio"]' : 'input[type="checkbox"]';
      const box = input.closest('fieldset, [role="group"], [role="radiogroup"]') ?? containerOf(input, sel);
      add(`${radio ? 'r' : 'c'}:${uid(box)}`, radio ? 'single' : 'multiple', true, input);
    }
  }

  // 2. ARIA radios / checkboxes
  for (const el of document.querySelectorAll<HTMLElement>(ARIA)) {
    if (el.matches(NATIVE) || el.closest(EXCLUDED)) continue;
    const role = el.getAttribute('role') ?? 'radio';
    const box = el.closest('[role="radiogroup"], [role="group"], fieldset') ?? containerOf(el, `[role="${role}"]`);
    add(`a:${role}:${uid(box)}`, role === 'checkbox' ? 'multiple' : 'single', false, el);
  }

  // 3. class-name heuristic: sibling "option"/"choice" cards without inputs or roles
  // 4. free-text answer controls (short answer / paragraph / number / date): each is its own question
  const handled = new Set<Element>([...document.querySelectorAll(NATIVE), ...document.querySelectorAll(ARIA)]);
  for (const el of document.querySelectorAll<HTMLElement>(TEXT)) {
    if (el.id === OVERLAY_ID || el.closest(EXCLUDED) || el.closest(`#${OVERLAY_ID}`)) continue;
    if (handled.has(el)) continue;
    if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).type === 'hidden') continue;
    if (!isRendered(el)) continue;
    // a text input that sits inside an option group (search boxes etc.) is not a question
    if (el.closest(`${NATIVE}, ${ARIA}`)) continue;
    const box = el.parentElement;
    if (!box) continue;
    add(`t:${uid(el)}`, 'text', false, el);
  }

  // 5. class-name heuristic: sibling "option"/"choice" cards without inputs or roles
  const candidates = [...document.querySelectorAll<HTMLElement>(CUSTOM)].filter(
    (el) =>
      el.id !== OVERLAY_ID &&
      !el.matches(NATIVE) &&
      !el.closest(EXCLUDED) &&
      !el.querySelector(`${NATIVE}, ${ARIA}`) &&
      (el.innerText ?? '').trim().length > 0,
  );
  const byParent = new Map<Element, HTMLElement[]>();
  for (const el of candidates) {
    const p = el.parentElement;
    if (!p) continue;
    const list = byParent.get(p);
    if (list) list.push(el);
    else byParent.set(p, [el]);
  }
  const customGroups = [...byParent.values()].filter((g) => g.length >= 2 && g.length <= 10);
  const members = new Set<Element>(customGroups.flat());
  for (const g of customGroups) {
    if (g.some((m) => hasAncestorIn(m, members))) continue; // nested inside another option group
    for (const m of g) add(`k:${uid(m.parentElement as Element)}`, 'single', false, m);
  }

  // 4. turn groups into blocks
  const textGroups = [...groups.values()].filter((g) => g.kind === 'text');
  const usable = [...groups.values()].filter((g) => g.kind !== 'text' && g.controls.length >= 2 && g.controls.length <= 12);
  const withEls = usable
    .map((g) => ({ g, els: g.controls.map((c) => optionElementFor(c, g.controls)) }))
    .filter(({ els }) => new Set(els).size === els.length && els.filter(isRendered).length >= 2);
  const allEls = withEls.flatMap((x) => x.els);

  const blocks: QuestionBlock[] = [];
  for (const { g, els } of withEls) {
    const card = findCard(els, allEls.filter((e) => !els.includes(e)));
    if (!card) continue;
    blocks.push({
      card,
      kind: g.kind,
      options: els.map((el, i) => ({ el, control: g.controls[i], native: g.native })),
      fields: [],
    });
  }

  // text questions: each field is its own block; card = smallest ancestor with stem text around it
  for (const g of textGroups) {
    const control = g.controls[0];
    const card = findTextCard(control);
    if (!card) continue;
    blocks.push({ card, kind: 'text', options: [], fields: [control] });
  }
  return blocks;
}

/** Smallest ancestor of `control` that contains some text which is not the control itself. */
function findTextCard(control: HTMLElement): HTMLElement | null {
  let a: HTMLElement | null = control.parentElement;
  for (let i = 0; a && i < 8; i++, a = a.parentElement) {
    if (a === document.body || a === document.documentElement) break;
    const len = visibleLength(a) - visibleLength(control);
    if (len >= 8) return a;
  }
  return null;
}

/** Which question/option does this event target belong to? */
export function findOption(target: Element): { block: QuestionBlock; option: OptionRef } | null {
  for (const block of scanBlocks()) {
    for (const option of block.options) {
      if (option.control === target || option.el.contains(target) || option.control.contains(target)) {
        return { block, option };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// text extraction (math-aware)
// ---------------------------------------------------------------------------
const BLOCK_TAGS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'br', 'tr', 'table', 'section', 'article', 'blockquote', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend', 'fieldset', 'form', 'figcaption',
]);
const SKIP_TAGS = new Set(['style', 'noscript', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'img', 'template']);

interface Ctx {
  skip: Set<Element>;
  latex: string[];
}

function isHidden(el: Element): boolean {
  if (el.getAttribute('aria-hidden') === 'true') return true;
  const cs = getComputedStyle(el);
  return cs.display === 'none' || cs.visibility === 'hidden';
}

function followedByTexScript(el: Element): boolean {
  let s = el.nextElementSibling;
  while (s && isMathJaxV2Output(s)) s = s.nextElementSibling;
  return !!s && isMathScript(s);
}

function walk(node: Node, ctx: Ctx, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue ?? '';
    // HTML collapses source whitespace; only block tags / <br> / <pre> make real line breaks
    out.push(node.parentElement?.closest('pre') ? text : text.replace(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  if (ctx.skip.has(el) || el.id === OVERLAY_ID || el.matches(FEEDBACK)) return;

  // MathJax v2: TeX source is in a sibling <script>; the rendered copy is ignored.
  if (isMathScript(el)) {
    const tex = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (tex) {
      ctx.latex.push(tex);
      out.push(isMathScriptDisplay(el) ? `$$${tex}$$` : `$${tex}$`);
    }
    return;
  }
  if (isMathJaxV2Output(el)) {
    if (!followedByTexScript(el)) {
      const t = (el.textContent ?? '').replace(/[\u200b\s]+/g, ' ').trim();
      if (t) {
        ctx.latex.push(t);
        out.push(`[math: ${t}]`);
      }
    }
    return;
  }

  const tag = el.localName;
  if (el.getAttribute('role') === 'button') return;
  if (SKIP_TAGS.has(tag) && !mathFromElement(el)) return;
  if (isHidden(el)) return;

  const math = mathFromElement(el);
  if (math) {
    ctx.latex.push(math.raw);
    out.push(math.text);
    return;
  }

  const block = BLOCK_TAGS.has(tag);
  if (block) out.push('\n');
  for (const child of el.childNodes) walk(child, ctx, out);
  if (block) out.push('\n');
}

function tidy(s: string): string {
  return s
    .replace(/[\u00a0\u200b]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Text of `root` with math inlined as $...$; children listed in `skip` are left out. */
export function collectText(root: Element, skip: Set<Element>, latex: string[]): string {
  const out: string[] = [];
  const ctx: Ctx = { skip, latex };
  for (const child of root.childNodes) walk(child, ctx, out); // root itself is exempt from the FEEDBACK/hidden checks
  return tidy(out.join(''));
}

/**
 * Strip "Question 3", "Question 3 of 10", "3." and "3)" prefixes. A bare leading number such as
 * "2x + 3 = 7" or "5 apples..." is part of the question and is kept (the old code deleted it).
 */
export function cleanStem(raw: string): string {
  return tidy(raw)
    .replace(/^\s*(?:question|q)\s*\d+(?:\s*(?:of|\/)\s*\d+)?\s*[.:)\-–]?\s*/i, '')
    .replace(/^\s*\d{1,3}\s*[.)]\s+(?=\S)/, '')
    .trim();
}

// ---------------------------------------------------------------------------
// public: describe a block
// ---------------------------------------------------------------------------
export function describeBlock(block: QuestionBlock): DescribedQuestion | null {
  const latex: string[] = [];

  // free-text question: the stem lives outside the field, there are no options
  if (block.kind === 'text') {
    const fieldEls = new Set<Element>(block.fields);
    const stem = cleanStem(collectText(block.card, fieldEls, latex));
    if (stem.length < 6) return null;
    const visuals = pickVisuals(block.card);
    const uniqueLatex = [...new Set(latex)];
    const key = hash53(['text', stem, uniqueLatex.join(''), String(visuals.length)].join('\u241f'));
    return { key, block, kind: 'text', stem, options: [], fields: block.fields, latex: uniqueLatex, visuals };
  }

  const optionEls = new Set<Element>(block.options.map((o) => o.el));

  const stem = cleanStem(collectText(block.card, optionEls, latex));
  if (stem.length < 6) return null;

  const seen = new Set<string>();
  const options: DescribedOption[] = [];
  for (const [i, o] of block.options.entries()) {
    let text = normalizeText(collectText(o.el, new Set(), latex));
    if (!text) {
      // ARIA widgets usually carry the answer text in an attribute
      text = normalizeText(
        o.control.getAttribute('aria-label') ?? o.control.getAttribute('data-value') ?? o.control.getAttribute('data-answer-value') ?? '',
      );
    }
    if (!text) text = o.el.querySelector('img[alt]')?.getAttribute('alt')?.trim() ?? '';
    if (!text) {
      if (!o.el.querySelector('img, svg, canvas')) return null; // no text and no picture: cannot read this option
      text = `[image option ${i + 1}]`;
    }
    let hash = hash53(text.toLowerCase());
    if (seen.has(hash)) hash = hash53(`${text.toLowerCase()}#${i}`);
    seen.add(hash);
    options.push({ ...o, text, hash });
  }

  // Guardrail (was a backend band-aid): if the "stem" is really one of the options, extraction failed.
  const normStem = normalizeText(stem).toLowerCase();
  if (options.some((o) => normalizeText(o.text).toLowerCase() === normStem)) return null;
  // ...or if the options leaked into the stem (card detection stopped too early): better to say nothing than to send garbage.
  const stemLines = new Set(stem.split('\n').map((l) => normalizeText(l).toLowerCase()));
  if (options.filter((o) => stemLines.has(normalizeText(o.text).toLowerCase())).length >= 2) return null;

  const visuals = pickVisuals(block.card);
  const uniqueLatex = [...new Set(latex)];
  const key = hash53(
    [block.kind, stem, ...options.map((o) => o.hash).sort(), uniqueLatex.join('\u0001'), String(visuals.length)].join('\u241f'),
  );
  return { key, block, kind: block.kind, stem, options, fields: block.fields, latex: uniqueLatex, visuals };
}

/** Locate the question block that owns a given answer control (options, free text or dropdown). */
export function findField(target: Element): QuestionBlock | null {
  for (const block of scanBlocks()) {
    if (block.fields.some((f) => f === target || f.contains(target) || target.contains(f))) return block;
    for (const option of block.options) {
      if (option.control === target || option.el.contains(target) || option.control.contains(target)) return block;
    }
  }
  // A dropdown menu often renders its options elsewhere in the DOM once open:
  // an ARIA option belongs to the text question whose card contains it.
  const optEl = target.closest('[role="option"]');
  if (optEl) {
    for (const block of scanBlocks()) {
      if (block.kind === 'text' && block.card.contains(optEl)) return block;
    }
  }
  return null;
}
