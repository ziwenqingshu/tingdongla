// Match slide photos to stretches of the recording.
// Each transcript window gets a slide by TF-IDF cosine similarity, with a monotonic
// dynamic program (lectures move forward through the deck; skipping slides is allowed,
// going back costs a penalty). Result: for every slide, the time range where it is discussed.
import { tokens } from './text.js';

function tf(toks) {
  const m = new Map();
  for (const t of toks) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

export function buildIdf(docs) {
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const n = docs.length;
  const idf = new Map();
  for (const [t, c] of df) idf.set(t, Math.log(1 + n / c));
  return idf;
}

function vec(toks, idf) {
  const v = new Map();
  for (const [t, c] of tf(toks)) v.set(t, (1 + Math.log(c)) * (idf.get(t) || 0));
  let n = 0; for (const x of v.values()) n += x * x;
  return { v, n: Math.sqrt(n) || 1 };
}

function cos(a, b) {
  let s = 0;
  const [small, big] = a.v.size < b.v.size ? [a, b] : [b, a];
  for (const [t, x] of small.v) { const y = big.v.get(t); if (y) s += x * y; }
  return s / (a.n * b.n);
}

/**
 * @param {{text:string}[]} slides  OCR text per slide, in upload order
 * @param {{start:number,end:number,text:string}[]} wins transcript windows
 * @param {{ordered?: boolean, backPenalty?: number, minSim?: number}} opt
 * @returns {{assign:number[], sims:number[][], ranges:{slide:number,start:number,end:number,score:number}[][]}}
 */
export function alignSlides(slides, wins, opt = {}) {
  const ordered = opt.ordered !== false;
  const backPenalty = opt.backPenalty ?? 0.08;
  const minSim = opt.minSim ?? 0.04;
  const sTok = slides.map(s => tokens(s.text));
  const wTok = wins.map(w => tokens(w.text));
  const idf = buildIdf([...sTok, ...wTok]);
  const sv = sTok.map(t => vec(t, idf));
  const wv = wTok.map(t => vec(t, idf));
  const S = slides.length, W = wins.length;
  const sims = wv.map(w => sv.map(s => cos(w, s)));
  // State -1 = "no slide on screen" (intro chatter, questions). Index shift by 1.
  const NONE = 0;
  const score = (i, j) => (j === NONE ? minSim : sims[i][j - 1]);
  const dp = Array.from({ length: W }, () => new Float64Array(S + 1).fill(-Infinity));
  const bp = Array.from({ length: W }, () => new Int32Array(S + 1).fill(-1));
  for (let j = 0; j <= S; j++) dp[0][j] = score(0, j);
  for (let i = 1; i < W; i++) {
    for (let j = 0; j <= S; j++) {
      let best = -Infinity, arg = -1;
      for (let k = 0; k <= S; k++) {
        let p = dp[i - 1][k];
        if (ordered && j !== NONE && k !== NONE && j < k) p -= backPenalty; // going back in the deck
        if (j !== k) p -= 0.01; // small switching cost keeps runs stable
        if (p > best) { best = p; arg = k; }
      }
      dp[i][j] = best + score(i, j); bp[i][j] = arg;
    }
  }
  const assign = new Array(W).fill(-1);
  if (W) {
    let j = 0; for (let k = 1; k <= S; k++) if (dp[W - 1][k] > dp[W - 1][j]) j = k;
    for (let i = W - 1; i >= 0; i--) { assign[i] = j - 1; j = bp[i][j] >= 0 ? bp[i][j] : j; }
  }
  const ranges = Array.from({ length: S }, () => []);
  for (let i = 0; i < W; i++) {
    const s = assign[i];
    if (s < 0) continue;
    const r = ranges[s], last = r[r.length - 1];
    if (last && i > 0 && assign[i - 1] === s) { last.end = wins[i].end; last.score = Math.max(last.score, sims[i][s]); }
    else r.push({ slide: s, start: wins[i].start, end: wins[i].end, score: sims[i][s] });
  }
  return { assign, sims, ranges };
}

// Group windows into chunks of about `target` seconds for the language model, cutting at
// slide changes where possible. Each chunk lists the slides shown during it.
export function chunks(wins, assign, target = 240, maxLen = 420) {
  const out = [];
  let cur = null;
  wins.forEach((w, i) => {
    const s = assign[i];
    const len = cur ? w.end - cur.start : 0;
    const slideChanged = cur && i > 0 && assign[i - 1] !== s;
    if (!cur || (len > target && slideChanged) || len > maxLen) {
      cur = { start: w.start, end: w.end, wins: [], slides: [] }; out.push(cur);
    }
    cur.end = w.end; cur.wins.push(w);
    if (s >= 0 && !cur.slides.includes(s)) cur.slides.push(s);
  });
  // A tiny tail chunk joins the previous one.
  if (out.length > 1 && out[out.length - 1].end - out[out.length - 1].start < 60) {
    const t = out.pop(), p = out[out.length - 1];
    p.end = t.end; p.wins.push(...t.wins); for (const s of t.slides) if (!p.slides.includes(s)) p.slides.push(s);
  }
  return out;
}
