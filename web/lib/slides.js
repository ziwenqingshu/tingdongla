// Slide photo text clean-up (pure; used after OCR in the browser and in Node tests).
// Photos of a deck repeat the same header/footer/licence lines on every slide, and OCR on
// formulas or charts produces junk lines. Both hurt slide↔audio matching and waste prompt
// space, so we drop them before alignment and before anything reaches the language model.
import { tokens, normalize } from './text.js';

function lineKey(l) { return tokens(l).slice(0, 12).join(' '); }

// Junk: mostly non-letters, or mostly 1–2 letter fragments ("ee me pe ca cr").
export function isJunk(line) {
  const l = line.trim();
  if (l.length < 3) return true;
  const letters = (l.match(/[A-Za-z\u3400-\u9fff]/g) || []).length;
  if (letters / l.length < 0.5) return true;
  const words = l.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
  if (/[\u3400-\u9fff]/.test(l)) return false;
  if (!words.length) return true;
  const short = words.filter(w => w.replace(/[^A-Za-z]/g, '').length <= 3).length;
  const caps = words.filter(w => /^[A-Z]{3,}$/.test(w)).length; // OCR noise like "FRR ERR REBFEE"
  return words.length >= 3 && (short / words.length > 0.5 || caps / words.length > 0.6);
}

function jaccard(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let i = 0; for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i || 1);
}

/**
 * @param {{text:string, conf?:number}[]} slides raw OCR per slide
 * @returns {{text:string, title:string, removed:number, conf?:number, readable:boolean}[]}
 */
export function cleanSlides(slides) {
  const per = slides.map(s => String(s.text || '').split('\n').map(l => l.trim()).filter(Boolean));
  const keys = per.map(lines => lines.map(lineKey));
  const n = slides.length;
  // Tokens that occur on a large share of slides are deck boilerplate (logo, licence, footer).
  const df = new Map();
  for (const lines of per) for (const t of new Set(tokens(lines.join(' ')))) df.set(t, (df.get(t) || 0) + 1);
  const common = t => n >= 4 && df.get(t) >= Math.max(3, Math.ceil(n * 0.3));
  const repeated = (k, self, line) => {
    if (n < 3) return false;
    const tk = tokens(line);
    if (tk.length >= 2 && tk.filter(common).length / tk.length >= 0.5) return true;
    if (!k) return false;
    let c = 0;
    keys.forEach((ks, j) => { if (j !== self && ks.some(o => o && jaccard(o, k) >= 0.6)) c++; });
    return c + 1 >= Math.max(3, Math.ceil(n * 0.4));
  };
  return per.map((lines, i) => {
    const kept = lines.filter((l, li) => !isJunk(l) && !repeated(keys[i][li], i, l));
    const text = kept.join('\n');
    const title = (kept.find(l => tokens(l).length >= 1 && l.length <= 80) || '').replace(/[|~=_*®°•§]+/g, ' ').replace(/\s+/g, ' ').trim();
    const readable = tokens(text).length >= 3 && (s => s.conf == null || s.conf >= 35)(slides[i]);
    return { text, title, removed: lines.length - kept.length, conf: slides[i].conf, readable };
  });
}

export { normalize };
