import type { Msg, Reply } from './types';

/** Promise wrapper around chrome.runtime.sendMessage that never throws and never hangs silently. */
export function send<T>(msg: Msg): Promise<Reply<T>> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (reply: Reply<T> | undefined) => {
        const err = chrome.runtime.lastError;
        if (err || !reply) {
          resolve({ ok: false, code: 'no_response', message: err?.message ?? 'No response from the extension background.' });
        } else {
          resolve(reply);
        }
      });
    } catch {
      // Thrown when the extension was reloaded and this page still runs the old script.
      resolve({ ok: false, code: 'context_invalidated', message: 'The extension was reloaded. Refresh this page and start again.' });
    }
  });
}
