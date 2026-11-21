// Review-pack generation with a language model (OpenAI-compatible chat API).
// Runs in the browser (and in Node for tests). The student's own API key is kept in the
// browser and sent only to the chosen provider. Only text is sent: transcript lines with
// timestamps and cleaned slide text; never the audio or the photos.

export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter (free models)',
    base: 'https://openrouter.ai/api/v1',
    models: ['nvidia/nemotron-3-ultra-550b-a55b:free', 'google/gemma-4-31b-it:free', 'inclusionai/ling-3.2-flash:free'],
    keyUrl: 'https://openrouter.ai/settings/keys',
  },
  dashscope: {
    label: 'Alibaba Model Studio (Qwen)',
    base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-flash', 'qwen-plus'],
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  deepseek: {
    label: 'DeepSeek',
    base: 'https://api.deepseek.com',
    models: ['deepseek-chat'],
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
};

export const SYSTEM = `You write study material for a university student from ONE lecture: what the lecturer SAID (a timestamped transcript made by speech recognition) and what the SLIDES showed (OCR text from phone photos, may contain errors).

Hard rules:
1. Use only information that is in the transcript or slides. Never add facts, examples, numbers or names from your own knowledge.
2. Every item MUST cite where it comes from: "t" = the [mm:ss] or [h:mm:ss] time of the transcript line it is based on, exactly as written in the input; "slide" = the slide number if a slide shows it, else null; "quote" = 5 to 20 consecutive words copied EXACTLY from that transcript line (or from the slide text if it was only on the slide). Do not translate or fix the quote.
3. Speech recognition makes mistakes. If a word is obviously misheard, write the correct term in the item text, but keep the quote as written.
4. Write item text in the requested output language. The quote stays in the original language.
5. Output one JSON object only, no markdown fences, no comments.`;

export function sectionPrompt({ lecture, part, parts, lang }, lines, slides) {
  const out = [];
  out.push(`Lecture: ${lecture || '(untitled)'} — part ${part} of ${parts}.`);
  out.push(`Output language for item text: ${lang || "the lecture's language"}.`);
  out.push(`Task: write the notes for this part. Return JSON:
{"title": "short heading for this part (max 8 words)",
 "points": [{"text": "one key idea, max 30 words", "t": "mm:ss", "slide": 3, "quote": "..."}],
 "cards": [{"q": "flashcard question", "a": "short answer, max 25 words", "t": "mm:ss", "slide": null, "quote": "..."}]}
Give 3 to 6 points in the order they were taught and 2 to 4 cards on definitions, formulas, causes or comparisons a student must remember. Skip course admin (exam dates, office hours) unless it is the only content.`);
  if (slides.length) {
    out.push('SLIDES shown during this part:');
    for (const s of slides) out.push(`[slide ${s.n}] ${s.text.replace(/\n/g, ' / ')}`);
  }
  out.push('TRANSCRIPT:');
  for (const l of lines) out.push(`[${l.t}] ${l.text}`);
  return out.join('\n');
}

export function quizPrompt({ lecture, lang, count = 5 }, points) {
  const out = [];
  out.push(`Lecture: ${lecture || '(untitled)'}. Output language for item text: ${lang || "the lecture's language"}.`);
  out.push(`Task: write a ${count}-question multiple-choice self-test that covers the WHOLE lecture, using only the key points below. Each question tests understanding, not trivia. Return JSON:
{"quiz": [{"q": "question", "options": ["A", "B", "C", "D"], "answer": 0, "explain": "why, max 30 words", "t": "mm:ss", "slide": null, "quote": "..."}]}
"answer" is the 0-based index of the correct option. Copy t, slide and quote from the key point the question is based on.`);
  out.push('KEY POINTS (with their sources):');
  for (const p of points) out.push(`- ${p.text} | t=${p.t} | slide=${p.slide ?? 'null'} | quote="${p.quote}"`);
  return out.join('\n');
}

// ---------- output parsing & validation ----------
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export function extractJson(s) {
  const t = String(s || '').replace(/^```(?:json)?/m, '').replace(/```\s*$/m, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
const TIME = /^(\d+:)?\d{1,2}:\d{2}$/;
function cite(x) {
  const t = TIME.test(String(x?.t || '').trim()) ? String(x.t).trim() : '';
  const n = Number(x?.slide);
  return { t, slide: Number.isInteger(n) && n > 0 && n < 500 ? n : null, quote: clean(x?.quote, 240) };
}
export function validSection(o) {
  if (!o || typeof o !== 'object' || !Array.isArray(o.points)) return null;
  const points = o.points.slice(0, 8).map(p => ({ text: clean(p?.text, 400), ...cite(p) })).filter(p => p.text);
  const cards = (Array.isArray(o.cards) ? o.cards : []).slice(0, 6)
    .map(c => ({ q: clean(c?.q, 300), a: clean(c?.a, 400), ...cite(c) })).filter(c => c.q && c.a);
  if (!points.length) return null;
  return { title: clean(o.title, 80) || 'Untitled part', points, cards };
}
export function validQuiz(o) {
  if (!o || !Array.isArray(o.quiz)) return null;
  const quiz = o.quiz.slice(0, 8).map(q => {
    const options = Array.isArray(q?.options) ? q.options.slice(0, 5).map(x => clean(x, 200)).filter(Boolean) : [];
    return { q: clean(q?.q, 300), options, answer: Number(q?.answer), explain: clean(q?.explain, 400), ...cite(q) };
  }).filter(q => q.q && q.options.length >= 3 && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < q.options.length);
  return quiz.length >= 2 ? { quiz } : null;
}

// ---------- API call ----------
export class LlmError extends Error {
  constructor(code, detail = '') { super(code); this.code = code; this.detail = detail; }
}

async function chat(cfg, prompt, { signal, timeoutMs = 180000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctl.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  let r;
  try {
    r = await fetch(cfg.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.key}`,
        ...(cfg.base.includes('openrouter.ai') ? { 'X-Title': 'TingDongLa' } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }],
      }),
    });
  } catch (e) {
    if (signal?.aborted) throw new LlmError('cancelled');
    throw new LlmError(ctl.signal.aborted ? 'timeout' : 'network', String(e?.message || e).slice(0, 120));
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    const code = r.status === 401 || r.status === 403 ? 'bad_key' : r.status === 429 ? 'rate_limited'
      : r.status === 402 ? 'no_credit' : r.status >= 500 ? 'service_down' : 'rejected';
    throw new LlmError(code, `${r.status} ${body.slice(0, 160)}`);
  }
  const j = await r.json().catch(() => null);
  const text = j?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) throw new LlmError('empty_reply');
  return text;
}

// One call with validation and a single repair retry when the JSON is malformed.
async function generateOne(cfg, prompt, validate, opt) {
  let raw = await chat(cfg, prompt, opt);
  let out = validate(extractJson(raw));
  let retried = false;
  if (!out) {
    retried = true;
    raw = await chat(cfg, prompt + '\n\nYour previous reply was not valid JSON in the required shape. Reply again with the JSON object only.', opt);
    out = validate(extractJson(raw));
  }
  if (!out) throw new LlmError('bad_output', raw.slice(0, 200));
  return { out, retried };
}

const TRANSIENT = new Set(['rate_limited', 'service_down', 'timeout', 'network', 'empty_reply', 'bad_output']);
const wait = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new LlmError('cancelled')); }, { once: true });
});

// Free models are often rate-limited upstream. On a temporary error we wait briefly and
// move on to the next model in cfg.fallbacks; a wrong key or missing credit stops at once.
// opt.onAttempt({model, code}) reports each failed attempt to the UI.
export async function generate(cfg, prompt, validate, opt = {}) {
  const t0 = Date.now();
  // After the fallbacks, the first model gets one more try: free-tier 429s usually clear in seconds.
  const models = [cfg.model, ...(cfg.fallbacks || []).filter(m => m && m !== cfg.model), cfg.model];
  let last;
  for (let i = 0; i < models.length; i++) {
    try {
      const { out, retried } = await generateOne({ ...cfg, model: models[i] }, prompt, validate, opt);
      return { ...out, model: models[i], ms: Date.now() - t0, retried, fellBack: i > 0 };
    } catch (e) {
      last = e;
      opt.onAttempt?.({ model: models[i], code: e.code });
      if (!TRANSIENT.has(e.code) || e.code === 'cancelled') throw e;
      if (i + 1 < models.length) await wait(i + 2 === models.length ? 15000 : e.code === 'rate_limited' ? 4000 : 1000, opt.signal);
    }
  }
  throw last;
}
