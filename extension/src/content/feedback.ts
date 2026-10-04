/** Red buzzer / green highlight on page elements (blueprint 4.5). Styles come from highlight.css. */
const OK = 'sa-correct';
const BAD = 'sa-wrong';

export function clearHighlights(root: ParentNode): void {
  root.querySelectorAll(`.${OK}, .${BAD}`).forEach((el) => el.classList.remove(OK, BAD));
}

export function mark(el: HTMLElement, kind: 'ok' | 'bad'): void {
  el.classList.remove(OK, BAD);
  void el.offsetWidth; // restart the shake animation
  el.classList.add(kind === 'ok' ? OK : BAD);
}

let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(value: boolean): void {
  muted = value;
}

/** Short low "wrong answer" buzz. Works after any user click (browser autoplay policy). */
export function playBuzzer(): void {
  if (muted) return;
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx ??= new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = 150;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.36);
  } catch {
    /* audio is optional */
  }
}
