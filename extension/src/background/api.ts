/**
 * Backend client (service worker side): request queue with priorities, single-flight
 * de-duplication, and the L2 cache (chrome.storage.session). Blueprint 5.3.
 */
import { hash53 } from '../shared/hash';
import type { AnalysisResult, Priority, QuestionPayload, Session } from '../shared/types';

const API_BASE: string = import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:8000';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 0) {
    super(message);
  }
}

async function request<T>(path: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = res.statusText || 'Request failed';
      try {
        const detail = (await res.json())?.detail;
        if (Array.isArray(detail)) {
          code = 'invalid_request'; // FastAPI validation errors
          message = detail.map((d: { msg?: string }) => d.msg).filter(Boolean).join('; ') || message;
        } else if (detail && typeof detail === 'object') {
          code = detail.error_code ?? code;
          message = detail.message ?? message;
        }
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(code, message, res.status);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if ((e as Error).name === 'AbortError') throw new ApiError('timeout', 'The server took too long to answer.');
    throw new ApiError('network', `Cannot reach the study server at ${API_BASE}. Is it running?`);
  } finally {
    clearTimeout(timer);
  }
}

export const createSession = (subject: string, topic: string): Promise<Session> =>
  request<Session>('/v1/sessions', { subject, topic });

// ---- priority queue ---------------------------------------------------------
const MAX_CONCURRENT = 3; // speculative calls per user (blueprint cost guard)
interface Job {
  priority: number;
  run: () => Promise<void>;
}
const queue: Job[] = [];
let active = 0;

function pump(): void {
  while (queue.length) {
    const next = queue[0];
    // foreground work (a learner is waiting) may use two extra slots so prefetches never starve it
    if (active >= (next.priority ? MAX_CONCURRENT + 2 : MAX_CONCURRENT)) break;
    queue.shift();
    active++;
    void next.run().finally(() => {
      active--;
      pump();
    });
  }
}

function schedule<T>(priority: Priority, fn: () => Promise<T>): { promise: Promise<T>; job: Job } {
  let job!: Job;
  const promise = new Promise<T>((resolve, reject) => {
    job = {
      priority: priority === 'foreground' ? 1 : 0,
      run: async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      },
    };
  });
  queue.push(job);
  queue.sort((a, b) => b.priority - a.priority); // stable
  pump();
  return { promise, job };
}

// ---- L2 cache ---------------------------------------------------------------
const TTL_MS = 60 * 60 * 1000;
async function readL2(key: string): Promise<AnalysisResult | null> {
  try {
    const entry = (await chrome.storage.session.get(key))[key] as { r: AnalysisResult; exp: number } | undefined;
    return entry && entry.exp > Date.now() ? entry.r : null;
  } catch {
    return null;
  }
}
async function writeL2(key: string, r: AnalysisResult): Promise<void> {
  try {
    await chrome.storage.session.set({ [key]: { r, exp: Date.now() + TTL_MS } });
  } catch {
    /* quota or unavailable: the cache is an optimisation only */
  }
}

// ---- single-flight analyze ---------------------------------------------------
const inflight = new Map<string, { promise: Promise<AnalysisResult>; job: Job }>();

export async function analyze(payload: QuestionPayload, priority: Priority): Promise<AnalysisResult> {
  const key =
    'a:' +
    hash53(
      JSON.stringify([
        payload.session_id,
        payload.stem_text,
        payload.options.map((o) => o.opt_hash).sort(),
        payload.latex,
        payload.images.length,
        payload.visuals_total,
      ]),
    );

  const cached = await readL2(key);
  if (cached) return { ...cached, cached: true };

  const existing = inflight.get(key);
  if (existing) {
    // a click arrived while the prefetch is still queued: promote it
    if (priority === 'foreground' && existing.job.priority === 0 && queue.includes(existing.job)) {
      existing.job.priority = 1;
      queue.sort((a, b) => b.priority - a.priority);
      pump();
    }
    return existing.promise;
  }

  const { promise: raw, job } = schedule(priority, () => request<AnalysisResult>('/v1/analyze', payload));
  const promise = raw
    .then(async (r) => {
      await writeL2(key, r);
      return r;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, { promise, job });
  return promise;
}
