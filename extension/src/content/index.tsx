import { createRoot } from 'react-dom/client';
import { App } from '../overlay/App';
import { OVERLAY_ID } from '../shared/constants';

declare global {
  interface Window {
    __aiStudyAgentLoaded?: boolean;
  }
}

/**
 * Injected on demand by the service worker (action click), not on every page.
 * The overlay lives in a Shadow DOM so host-page CSS cannot break it and ours cannot leak out.
 */
function mount(): void {
  if (window.__aiStudyAgentLoaded) return;
  window.__aiStudyAgentLoaded = true;

  // an orphan from a previous extension version/reload would otherwise leave a dead duplicate
  document.getElementById(OVERLAY_ID)?.remove();

  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
  document.documentElement.appendChild(host); // <html>, not <body>: immune to body transforms

  const shadow = host.attachShadow({ mode: 'open' });
  const mountPoint = document.createElement('div');
  shadow.appendChild(mountPoint);
  createRoot(mountPoint).render(<App />);
}

mount();
