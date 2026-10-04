# Agentic AI Study Assistant

A Chrome MV3 extension + FastAPI backend + Claude that reads quiz questions on any page (Google Forms,
LMS, custom HTML quizzes), explains them, checks your answers instantly, and can **solve a whole quiz for
you** (scrolling, clicking, and typing by itself).

## What it can do

### Practice Mode (checks answers instantly)
- **Works with every common question type:**
  - Single choice (radio / ARIA radio / option cards)
  - Multiple choice (native or ARIA checkboxes)
  - Short answer / paragraph text inputs
  - Number inputs and date inputs
  - Dropdowns (`role="listbox"` / `<select>` / comboboxes)
- Extracts the stem, options and math (KaTeX / MathJax v2 / MathJax v3 / MathML), captures figures,
  and anchors the analysis to the **Subject/Topic** you declared so it tells you — not guesses — when a
  question falls outside the session.
- Speculative **prefetch**: each question is analyzed as it scrolls into view, so the verdict (✓/✗ with a
  *Why?*), buzzer and highlights appear essentially instantly on every click.
- Text answers compared with fuzzy normalization (`"1,000.0" ≈ "1000" ≈ "1000.00"`, case/whitespace/"$"
  safe).

### Answer Mode (auto-solves the whole page)
Click **▶ Auto-solve whole quiz** and the agent:

1. scans every question (options, text fields, dropdowns),
2. analyzes it with the same secure backend used by Practice Mode,
3. performs the interaction **itself** — clicking radio/checkbox options, typing into text/number fields
   through the native setter + `input`/`change` events, and opening + clicking the matching dropdown
   option,
4. scrolls through the page (top to bottom) waiting for lazy-loaded questions,
5. then stops with `Finished. Filled in N question(s).`

It never clicks Submit — you review the filled answers and submit yourself.
Stop any time with the **■ Stop** button or `Esc`.

## Architecture

| Layer | Directory | What's inside |
|---|---|---|
| Extension | `extension/` | React Vite + CrxJS (MV3), content scripts (detector / extractor / interceptor / executor / practice / vision), Shadow-DOM overlay |
| Backend | `backend/` | FastAPI app, cache (in-flight dedup + TTL/LRU), Claude adapter with tool-use structured output, one repair retry, escalation model |
| Shared types | `extension/src/shared/` | Payload/result TypeScript types |

Features: L1 (page memory) + L2 (`chrome.storage.session`) + L3 (server TTL/LRU) cache tiers, single-flight
de-duplication, priority queue (foreground beats prefetch), session-capped analysis budget, API key stays only
on the backend, page content treated as untrusted, CORS restricted to the extension origin.

## Run it

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add your Anthropic key
uvicorn app.main:app --port 8000

# extension
cd ../extension
npm install
npm run build                   # or: npm run dev
# chrome://extensions -> Developer mode -> Load unpacked -> extension/dist
```

Then: click the toolbar icon on a quiz page → enter **Subject** and **Topic** → Start session.
- Clicking answers on the page gives instant verdicts (Practice Mode).
- **▶ Auto-solve whole quiz** runs Answer Mode.

## API

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | liveness |
| `POST /v1/sessions` | create a session (subject, topic, id) |
| `POST /v1/analyze` | analyze a question; `?prefetch=true` returns immediately |

## Known limitations

Top-frame only (iframes need `allFrames` injection); does not work on pages that render inside a shadow DOM;
native dropdowns inside frameworks with closed menu DOM may need an extra polling tick; submitting is left to you.
