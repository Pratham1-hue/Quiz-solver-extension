import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { setMuted, startPractice, type Feedback } from '../content/practice';
import { autoSolve } from '../content/executor';
import { send } from '../shared/messages';
import type { Session, TabMsg } from '../shared/types';

const C = { bg: '#1e1e2e', field: '#313244', line: '#45475a', text: '#cdd6f4', blue: '#89b4fa', dark: '#11111b' };
const FONT = 'system-ui, -apple-system, Segoe UI, sans-serif';

const input: CSSProperties = {
  width: '100%', padding: 8, borderRadius: 6, border: `1px solid ${C.line}`,
  background: C.field, color: '#fff', boxSizing: 'border-box', fontSize: 14,
};
const label: CSSProperties = { fontSize: 12, color: '#a6adc8', display: 'block', marginBottom: 4 };
const panel: CSSProperties = {
  position: 'absolute', bottom: 55, right: 0, width: 280, background: C.bg, color: C.text, padding: 18,
  borderRadius: 12, border: `1px solid ${C.line}`, boxShadow: '0 8px 24px rgba(0,0,0,.5)',
  display: 'flex', flexDirection: 'column', gap: 12,
};

const TONE: Record<Feedback['verdict'], { bg: string; border: string; head: string; title: string }> = {
  correct: { bg: '#14532d', border: '#22c55e', head: '#4ade80', title: '✓ Correct' },
  incorrect: { bg: '#7f1d1d', border: '#ef4444', head: '#f87171', title: '✗ Incorrect' },
  partial: { bg: '#713f12', border: '#eab308', head: '#facc15', title: '… Keep going' },
  unknown: { bg: '#27272a', border: '#71717a', head: '#d4d4d8', title: 'ℹ Cannot check this one' },
  pending: { bg: '#1e293b', border: '#475569', head: '#94a3b8', title: '⏳ Checking' },
};

export function App() {
  // Subject/Topic start EMPTY on purpose: the session anchor is what limits hallucinations.
  const [subject, setSubject] = useState('');
  const [topic, setTopic] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [visible, setVisible] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const [progress, setProgress] = useState({ analysing: 0, ready: 0 });
  const [muted, setMutedState] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);
  const autoStop = useRef<(() => void) | null>(null);

  // toolbar-icon click while already injected => show/hide
  useEffect(() => {
    const onMsg = (m: TabMsg) => {
      if (m?.type === 'TOGGLE_OVERLAY') setVisible((v) => !v);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    return () => chrome.runtime.onMessage.removeListener(onMsg);
  }, []);

  useEffect(() => {
    chrome.storage.local.get('muted').then((r) => {
      setMutedState(!!r.muted);
      setMuted(!!r.muted);
    }).catch(() => undefined);
  }, []);

  // The practice engine depends ONLY on the session. (The old effect also depended on the
  // subject/topic inputs, so typing in the form re-attached every listener.)
  useEffect(() => {
    if (!session) return;
    return startPractice(session, {
      onFeedback: (f) => {
        setFeedback(f);
        setWhyOpen(false);
        if (f) setError(null);
      },
      onProgress: setProgress,
      onError: (code, message) => {
        if (code === 'session_not_found') {
          setSession(null);
          setPanelOpen(true);
          setError('Your session expired (the server restarted). Please start a new one.');
        } else {
          setError(message);
        }
      },
    });
  }, [session]);

  // correct-answer dialogues fade out on their own
  useEffect(() => {
    if (feedback?.verdict !== 'correct') return;
    const t = window.setTimeout(() => setFeedback(null), 12000);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const reply = await send<Session>({ type: 'CREATE_SESSION', payload: { subject: subject.trim(), topic: topic.trim() } });
    setBusy(false);
    if (reply.ok) {
      setSession(reply.data);
      setPanelOpen(false);
    } else {
      setError(reply.message);
    }
  };

  const endSession = () => {
    autoStop.current?.();
    autoStop.current = null;
    setAutoMsg(null);
    setSession(null);
    setFeedback(null);
    setProgress({ analysing: 0, ready: 0 });
    setPanelOpen(true);
  };

  const toggleAuto = () => {
    if (autoStop.current) {
      autoStop.current();
      autoStop.current = null;
      setAutoMsg('Stopped.');
      return;
    }
    if (!session) return;
    setAutoMsg('Starting…');
    setPanelOpen(true);
    autoStop.current = autoSolve(session, {
      onStatus: setAutoMsg,
      onDone: (m) => {
        autoStop.current = null;
        setAutoMsg(m);
      },
    });
  };

  const toggleMute = () => {
    const next = !muted;
    setMutedState(next);
    setMuted(next);
    chrome.storage.local.set({ muted: next }).catch(() => undefined);
  };

  if (!visible) return null;
  const tone = feedback ? TONE[feedback.verdict] : null;

  return (
    <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 2147483647, fontFamily: FONT }}>
      {feedback && tone && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', top: 20, right: 20, background: tone.bg, border: `1px solid ${tone.border}`, color: '#fff',
          padding: '14px 36px 14px 18px', borderRadius: 10, maxWidth: 360, boxShadow: '0 8px 24px rgba(0,0,0,.5)', fontSize: 14,
        }}>
          <strong style={{ display: 'block', marginBottom: 4, color: tone.head }}>
            {tone.title}{' '}
            {feedback.instant && <span style={{ fontSize: 11, opacity: 0.8 }}>(⚡ instant)</span>}
          </strong>
          {feedback.message}
          {feedback.why && (
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setWhyOpen((v) => !v)} style={{ background: 'transparent', border: 'none', color: tone.head, cursor: 'pointer', padding: 0, fontSize: 13, textDecoration: 'underline' }}>
                {whyOpen ? 'Hide' : 'Why?'}
              </button>
              {whyOpen && <div style={{ marginTop: 6, opacity: 0.95 }}>{feedback.why}</div>}
            </div>
          )}
          <button type="button" aria-label="Dismiss" onClick={() => setFeedback(null)} style={{ position: 'absolute', top: 8, right: 10, background: 'transparent', border: 'none', color: '#aaa', cursor: 'pointer', fontSize: 14 }}>✕</button>
        </div>
      )}

      {error && !panelOpen && (
        <div role="alert" style={{ position: 'absolute', bottom: 55, right: 0, width: 260, background: '#7f1d1d', color: '#fff', padding: '10px 12px', borderRadius: 8, fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}

      <button type="button" onClick={() => setPanelOpen((v) => !v)} style={{
        background: session ? '#22c55e' : C.bg, color: session ? C.dark : '#fff', padding: '10px 16px', borderRadius: 20,
        border: `1px solid ${C.line}`, cursor: 'pointer', fontWeight: 600, boxShadow: '0 4px 14px rgba(0,0,0,.4)', fontSize: 14,
      }}>
        ⚡ {session ? `${session.subject} · ${progress.ready} ready${progress.analysing ? ` · ${progress.analysing} analysing` : ''}` : 'Start Study Session'}
      </button>

      {panelOpen && !session && (
        <form onSubmit={start} style={panel}>
          <h3 style={{ margin: 0, fontSize: 15, color: C.blue }}>Start a study session</h3>
          <div>
            <label style={label} htmlFor="sa-subject">Subject</label>
            <input id="sa-subject" style={input} required maxLength={120} placeholder="e.g. Organic Chemistry" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </div>
          <div>
            <label style={label} htmlFor="sa-topic">Topic</label>
            <input id="sa-topic" style={input} required maxLength={120} placeholder="e.g. SN1 / SN2 mechanisms" value={topic} onChange={(e) => setTopic(e.target.value)} />
          </div>
          {error && <div role="alert" style={{ color: '#f87171', fontSize: 13 }}>{error}</div>}
          <button type="submit" disabled={busy || !subject.trim() || !topic.trim()} style={{ background: C.blue, color: C.dark, padding: 10, borderRadius: 6, border: 'none', fontWeight: 'bold', cursor: busy ? 'wait' : 'pointer', opacity: busy || !subject.trim() || !topic.trim() ? 0.6 : 1 }}>
            {busy ? 'Connecting…' : 'Start session'}
          </button>
        </form>
      )}

      {panelOpen && session && (
        <div style={panel}>
          <h3 style={{ margin: 0, fontSize: 15, color: C.blue }}>Session active</h3>
          <div style={{ fontSize: 13 }}>
            <div><b>Subject:</b> {session.subject}</div>
            <div><b>Topic:</b> {session.topic}</div>
            <div style={{ marginTop: 6, color: '#a6adc8' }}>Answer a question on the page and you will get instant feedback.</div>
          </div>
          <button type="button" onClick={toggleAuto} style={{ background: autoStop.current ? '#ef4444' : C.blue, color: C.dark, padding: 10, borderRadius: 6, border: 'none', fontWeight: 'bold', cursor: 'pointer' }}>
            {autoStop.current ? '■ Stop auto-solve' : '▶ Auto-solve whole quiz'}
          </button>
          {autoMsg && <div role="status" style={{ fontSize: 12, color: '#a6adc8' }}>{autoMsg}</div>}
          <label style={{ ...label, display: 'flex', gap: 8, alignItems: 'center', margin: 0, cursor: 'pointer' }}>
            <input type="checkbox" checked={muted} onChange={toggleMute} /> Mute buzzer
          </label>
          <button type="button" onClick={endSession} style={{ background: C.field, color: C.text, padding: 8, borderRadius: 6, border: `1px solid ${C.line}`, cursor: 'pointer' }}>
            End session
          </button>
        </div>
      )}
    </div>
  );
}
