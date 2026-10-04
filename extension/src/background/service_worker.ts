/**
 * MV3 service worker (blueprint section 3): message router, on-demand injection, API + capture.
 * This file was missing entirely, so every chrome.runtime.sendMessage from the page went nowhere.
 */
import contentScript from '../content/index.tsx?script';
import highlightCss from '../content/highlight.css?inline';
import type { Msg, Reply, TabMsg } from '../shared/types';
import { analyze, ApiError, createSession } from './api';
import { captureRect } from './capture';

function toFailure(e: unknown): Reply<never> {
  if (e instanceof ApiError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, code: 'error', message: e instanceof Error ? e.message : String(e) };
}

function respond<T>(promise: Promise<T>, sendResponse: (r: Reply<T>) => void): true {
  promise.then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse(toFailure(e)),
  );
  return true; // keep the message channel open for the async reply
}

chrome.runtime.onMessage.addListener((msg: Msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  switch (msg.type) {
    case 'CREATE_SESSION':
      return respond(createSession(msg.payload.subject, msg.payload.topic), sendResponse);
    case 'ANALYZE':
      return respond(analyze(msg.payload, msg.priority), sendResponse);
    case 'CAPTURE_RECT':
      if (!sender.tab) {
        sendResponse({ ok: false, code: 'no_tab', message: 'No tab to capture.' });
        return false;
      }
      return respond(captureRect(sender.tab, msg.rect, msg.dpr), sendResponse);
    default:
      return false;
  }
});

async function flashBadge(tabId: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#ef4444' });
  await chrome.action.setBadgeText({ tabId, text: '×' });
  setTimeout(() => void chrome.action.setBadgeText({ tabId, text: '' }), 2500);
}

// Toolbar icon: show/hide if already injected, otherwise inject (activeTab grants access to this tab only).
chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined) return;
  const target = { tabId: tab.id };
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_OVERLAY' } satisfies TabMsg);
  } catch {
    try {
      await chrome.scripting.insertCSS({ target, css: highlightCss }); // insertCSS bypasses the page's CSP
      await chrome.scripting.executeScript({ target, files: [contentScript] });
    } catch (e) {
      console.warn('Study Agent cannot run on this page (chrome:// and Web Store pages are blocked):', e);
      await flashBadge(tab.id);
    }
  }
});
