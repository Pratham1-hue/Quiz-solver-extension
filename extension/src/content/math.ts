/**
 * Math extraction (blueprint 4.3).
 *
 * Content scripts live in an isolated world and cannot see the page's MathJax/KaTeX globals,
 * so everything here is DOM-based. We prefer the raw TeX source when the renderer keeps it
 * and fall back to MathML otherwise. We never use textContent of rendered math: KaTeX and
 * MathJax render the formula twice (visual + accessibility copy) and the result is mangled.
 */

export interface MathResult {
  /** what to inline into the stem/option text */
  text: string;
  /** raw LaTeX or MathML, collected into QuestionPayload.latex */
  raw: string;
}

const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"]';

const squash = (s: string): string => s.replace(/[\u200b\u2061-\u2064]/g, '').replace(/\s+/g, ' ').trim();
const wrap = (tex: string, display: boolean): string => (display ? `$$${tex}$$` : `$${tex}$`);

/** MathJax v2 keeps the TeX source in <script type="math/tex"> next to its rendered output. */
export function isMathScript(el: Element): boolean {
  return el.localName === 'script' && /^math\/tex/i.test(el.getAttribute('type') ?? '');
}

export function isMathScriptDisplay(el: Element): boolean {
  return /mode\s*=\s*display/i.test(el.getAttribute('type') ?? '');
}

/** Rendered output of MathJax v2 (.MathJax, .MathJax_Preview, .MathJax_Display, ...). v3 uses <mjx-container>. */
export function isMathJaxV2Output(el: Element): boolean {
  return el.localName !== 'mjx-container' && /(^|\s)MathJax(_[A-Za-z]+)*(\s|$)/.test(el.getAttribute('class') ?? '');
}

function fallback(el: Element): MathResult | null {
  const t = squash(el.getAttribute('aria-label') ?? el.textContent ?? '');
  return t ? { text: `[math: ${t}]`, raw: t } : null;
}

const isDisplay = (el: Element): boolean => ['true', 'block'].includes(el.getAttribute('display') ?? '');

/** If `el` is a rendered formula, return its source; otherwise null. */
export function mathFromElement(el: Element): MathResult | null {
  const tag = el.localName;

  // KaTeX: the TeX source lives in an <annotation> inside the hidden MathML copy.
  if (el.classList.contains('katex-display') || el.classList.contains('katex')) {
    const tex = squash(el.querySelector(TEX_ANNOTATION)?.textContent ?? '');
    if (tex) return { text: wrap(tex, el.classList.contains('katex-display')), raw: tex };
    return fallback(el); // KaTeX with output:'html' keeps no source
  }

  // MathJax v3 container, or a bare MathML element.
  if (tag === 'mjx-container' || tag === 'math') {
    const tex = squash(el.querySelector(TEX_ANNOTATION)?.textContent ?? '');
    if (tex) return { text: wrap(tex, isDisplay(el)), raw: tex };
    const mml = tag === 'math' ? el : el.querySelector('math');
    if (mml) {
      const raw = squash(mml.outerHTML);
      return { text: raw, raw }; // Claude reads MathML directly
    }
    return fallback(el);
  }

  // Equation images (e.g. Canvas LMS) carry the LaTeX in data/alt attributes.
  if (tag === 'img' && (el.hasAttribute('data-equation-content') || el.classList.contains('equation_image'))) {
    const tex = squash(el.getAttribute('data-equation-content') ?? el.getAttribute('alt') ?? '');
    return tex ? { text: wrap(tex, false), raw: tex } : null;
  }

  return null;
}
