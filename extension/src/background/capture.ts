/**
 * Screenshot + crop (blueprint 4.4). The content script sends a viewport-relative rect (CSS px);
 * we capture the visible tab, crop to that rect with OffscreenCanvas, downscale, and return base64.
 */
import type { Rect } from '../shared/types';

const MIN_INTERVAL_MS = 550; // captureVisibleTab is limited to ~2 calls per second
const MAX_EDGE = 1500; // long edge sent to Claude Vision

let chain: Promise<unknown> = Promise.resolve();
let last = 0;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function captureRect(tab: chrome.tabs.Tab, rect: Rect, dpr: number): Promise<{ mime: string; data_b64: string }> {
  const job = chain.then(async () => {
    const wait = last + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await doCapture(tab, rect, dpr);
    } finally {
      last = Date.now();
    }
  });
  chain = job.catch(() => undefined);
  return job;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return btoa(s);
}

async function doCapture(tab: chrome.tabs.Tab, rect: Rect, dpr: number) {
  // captureVisibleTab shoots whatever tab is showing in that window, so make sure it is ours.
  if (!tab.active || tab.windowId === undefined) throw new Error('The tab is not visible, so it cannot be captured.');

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());

  const sx = clamp(Math.round(rect.x * dpr), 0, bitmap.width - 1);
  const sy = clamp(Math.round(rect.y * dpr), 0, bitmap.height - 1);
  const sw = clamp(Math.round(rect.width * dpr), 1, bitmap.width - sx);
  const sh = clamp(Math.round(rect.height * dpr), 1, bitmap.height - sy);
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));

  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
  bitmap.close();

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { mime: 'image/png', data_b64: toBase64(new Uint8Array(await blob.arrayBuffer())) };
}
