// From transcript segments + cleaned slides to a checked review pack.
// Each lecture part is generated separately so a failed call loses only that part:
// earlier parts stay, the failed part falls back to an outline and can be retried.
import { windows, fmtTime } from './text.js';
import { alignSlides, chunks } from './align.js';
import { generate, sectionPrompt, quizPrompt, validSection, validQuiz } from './llm.js';
import { checkItem } from './verify.js';

export function plan(segs, slides, opt = {}) {
  const wins = windows(segs, opt.window || 45);
  const usable = slides.map((s, i) => ({ ...s, n: i + 1 }));
  const { assign, ranges, sims } = alignSlides(usable.map(s => ({ text: s.readable ? s.text : s.title || '' })), wins);
  const parts = chunks(wins, assign, opt.target || 300).map((c, i) => ({
    index: i, start: c.start, end: c.end, slides: c.slides.map(s => s + 1), wins: c.wins,
    status: 'pending', result: null, error: null,
  }));
  return { wins, assign, ranges, sims, parts };
}

function partLines(part, segs) {
  return segs.filter(s => s.start >= part.start - 0.01 && s.start < part.end + 0.01)
    .map(s => ({ t: fmtTime(s.start), text: s.text.trim() }));
}

// Outline used when the model is unavailable: slide titles + what was said, with times.
export function outlinePart(part, segs, slides) {
  const lines = partLines(part, segs);
  const title = part.slides.map(n => slides[n - 1]?.title).find(Boolean) || `Part ${part.index + 1}`;
  const step = Math.max(1, Math.floor(lines.length / 4));
  const points = [];
  for (let i = 0; i < lines.length && points.length < 4; i += step) {
    points.push({ text: lines[i].text, t: lines[i].t, slide: part.slides[0] ?? null, quote: lines[i].text, outline: true });
  }
  return { title, points, cards: [], outline: true };
}

export function srcOf(segs, slides) { return { segs, slides }; }

export async function runPart(part, ctx) {
  const { cfg, segs, slides, meta, signal } = ctx;
  const lines = partLines(part, segs);
  const sl = part.slides.map(n => ({ n, text: (slides[n - 1]?.text || '').slice(0, 900) })).filter(s => s.text);
  part.status = 'running'; part.error = null;
  try {
    const res = await generate(cfg, sectionPrompt({ ...meta, part: part.index + 1, parts: ctx.total }, lines, sl), validSection, { signal, onAttempt: ctx.onAttempt });
    const src = srcOf(segs, slides);
    for (const p of res.points) p.check = checkItem(p, src);
    for (const c of res.cards) c.check = checkItem(c, src);
    part.result = res; part.status = 'done';
  } catch (e) {
    part.error = { code: e.code || 'failed', detail: e.detail || String(e.message || e) };
    part.result = outlinePart(part, segs, slides);
    part.status = e.code === 'cancelled' ? 'cancelled' : 'failed';
  }
  return part;
}

export async function runQuiz(parts, ctx) {
  const pts = parts.filter(p => p.status === 'done').flatMap(p => p.result.points)
    .filter(p => p.check?.status !== 'unsupported')
    .map(p => ({ text: p.text, t: p.check?.t != null ? fmtTime(p.check.t) : p.t, slide: p.check?.slide ?? p.slide, quote: p.quote }));
  if (pts.length < 3) return { status: 'skipped', quiz: [] };
  try {
    const res = await generate(ctx.cfg, quizPrompt({ ...ctx.meta, count: Math.min(8, Math.max(4, Math.round(pts.length / 3))) }, pts), validQuiz, { signal: ctx.signal });
    const src = srcOf(ctx.segs, ctx.slides);
    for (const q of res.quiz) q.check = checkItem(q, src);
    return { status: 'done', quiz: res.quiz, model: res.model };
  } catch (e) {
    return { status: 'failed', quiz: [], error: { code: e.code || 'failed', detail: e.detail || '' } };
  }
}

export function stats(parts, quiz) {
  const s = { total: 0, verified: 0, moved: 0, unsupported: 0 };
  const add = it => { if (!it.check) return; s.total++; s[it.check.status]++; };
  for (const p of parts) if (p.status === 'done') { p.result.points.forEach(add); p.result.cards.forEach(add); }
  (quiz?.quiz || []).forEach(add);
  return s;
}
