// Text utilities shared by alignment, verification and the UI.
// Pure functions, no DOM: they run in the browser and in Node tests.

const STOP_EN = new Set(`a an the and or but if then else of to in on at by for with from as is are was were be been being
this that these those it its it's i you he she we they me him her us them my your our their what which who whom whose
when where why how all any both each few more most other some such no nor not only own same so than too very can will
just don don't should now do does did doing have has had having would could there here about into over under again
further once up down out off also let's let gonna going get got say said says ok okay well yeah um uh like actually
really kind sort thing things way one two lot right know think mean see going want go make made because while
during before after above below between through until against s t ll re ve m d`.split(/\s+/));
// A small Chinese function-word list; Chinese text is split into character bigrams.
const STOP_ZH = new Set('的 了 是 在 我 你 他 她 它 们 这 那 就 也 都 和 与 及 或 而 但 一个 一下 我们 你们 他们 这个 那个 什么 怎么 因为 所以 如果 然后 就是 还是 可以 没有 不是 有 很 吧 呢 啊 嗯 哦 对 吗'.split(' '));

const CJK = /[\u3400-\u9fff]/;

export function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .toLowerCase();
}

// Light English stemmer: enough to match "recursion"/"recursive", "markets"/"market".
export function stem(w) {
  if (w.length <= 4) return w;
  return w
    .replace(/(ization|ational|fulness|ousness|iveness)$/, '')
    .replace(/(ing|edly|ed|ies|es|ly|ment|ness|ive|ions|ion|al|s)$/, '')
    .replace(/e$/, '')
    .slice(0, 8);
}

// Content tokens: English words (stemmed, stopwords removed, digits kept) + Chinese bigrams.
export function tokens(s) {
  const out = [];
  const t = normalize(s);
  for (const m of t.matchAll(/[a-z][a-z'\-]*[a-z]|[a-z]|\d+(?:\.\d+)?%?|[\u3400-\u9fff]+/g)) {
    const w = m[0];
    if (CJK.test(w)) {
      if (w.length === 1) { if (!STOP_ZH.has(w)) out.push(w); continue; }
      for (let i = 0; i < w.length - 1; i++) {
        const bg = w.slice(i, i + 2);
        if (!STOP_ZH.has(bg)) out.push(bg);
      }
    } else if (/^\d/.test(w)) {
      out.push(w);
    } else {
      for (const part of w.split('-')) {
        if (part.length < 2 || STOP_EN.has(part)) continue;
        out.push(stem(part.replace(/'s$/, '')));
      }
    }
  }
  return out;
}

export function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function parseTime(str) {
  if (typeof str === 'number') return str;
  const m = String(str || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/);
  if (!m) return NaN;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +('0.' + m[4]) : 0);
}

// Parse SRT / WebVTT / "[mm:ss] text" / plain text into segments [{start, end, text}].
export function parseTranscript(raw, fallbackDuration = 0) {
  const text = String(raw || '').replace(/\r/g, '').replace(/^\uFEFF/, '');
  const segs = [];
  const cue = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;
  if (cue.test(text)) {
    for (const block of text.split(/\n\s*\n/)) {
      const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
      const i = lines.findIndex(l => cue.test(l));
      if (i < 0) continue;
      const [a, b] = lines[i].split('-->').map(x => parseTime(x.trim().split(/\s+/)[0].replace(',', '.')));
      const body = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
      if (body && Number.isFinite(a)) segs.push({ start: a, end: Number.isFinite(b) ? b : a + 5, text: body });
    }
    return segs;
  }
  const stamped = /^\s*\[?((?:\d+:)?\d{1,2}:\d{2})\]?\s+(.*)$/;
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length && lines.filter(l => stamped.test(l)).length >= lines.length * 0.6) {
    for (const l of lines) {
      const m = l.match(stamped);
      if (m) segs.push({ start: parseTime(m[1]), end: NaN, text: m[2] });
      else if (segs.length) segs[segs.length - 1].text += ' ' + l;
    }
    for (let i = 0; i < segs.length; i++) segs[i].end = i + 1 < segs.length ? segs[i + 1].start : segs[i].start + 10;
    return segs;
  }
  // Plain text without times: spread sentences evenly over the duration (times are then approximate).
  const sentences = text.split(/(?<=[.!?。！？])\s*/).map(s => s.trim()).filter(Boolean);
  const dur = fallbackDuration || sentences.length * 6;
  sentences.forEach((s, i) => segs.push({
    start: dur * i / sentences.length, end: dur * (i + 1) / sentences.length, text: s, approx: true,
  }));
  return segs;
}

// Merge ASR segments into windows of ~`size` seconds for alignment and prompting.
export function windows(segs, size = 45) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (!cur || s.start - cur.start >= size) { cur = { start: s.start, end: s.end, text: '', segs: [] }; out.push(cur); }
    cur.end = s.end; cur.text += (cur.text ? ' ' : '') + s.text.trim(); cur.segs.push(s);
  }
  return out;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
