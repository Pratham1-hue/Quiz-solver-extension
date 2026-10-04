export type QuestionKind = 'single' | 'multiple' | 'text';

export interface CapturedImage {
  image_id: string;
  mime: string;
  data_b64: string;
  caption: string;
}

export interface QuestionPayload {
  session_id: string;
  kind: QuestionKind;
  stem_text: string;
  options: { opt_hash: string; text: string }[];
  latex: string[];
  images: CapturedImage[];
  visuals_total: number;
  origin: string;
}

export interface AnalysisResult {
  content_hash: string;
  correct_opt_hashes: string[];
  /** for 'text' questions: the exact short answer the learner should type */
  text_answer?: string;
  confidence: number;
  needs_more_info: boolean;
  off_topic: boolean;
  visuals_missing: boolean;
  explanation_short: string;
  explanation_detail: string;
  distractors: Record<string, string>;
  model: string;
  prompt_version: string;
  cached: boolean;
}

export interface Session {
  session_id: string;
  subject: string;
  topic: string;
  prompt_version: string;
  max_analyses: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Priority = 'prefetch' | 'foreground';

/** content script -> service worker */
export type Msg =
  | { type: 'CREATE_SESSION'; payload: { subject: string; topic: string } }
  | { type: 'ANALYZE'; payload: QuestionPayload; priority: Priority }
  | { type: 'CAPTURE_RECT'; rect: Rect; dpr: number };

/** service worker -> content script */
export type TabMsg = { type: 'TOGGLE_OVERLAY' };

export type Reply<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
