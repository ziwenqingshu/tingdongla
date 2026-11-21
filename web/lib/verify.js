// Source check for every generated note, flashcard and quiz item.
// The model must cite a time (mm:ss), optionally a slide number, and a short verbatim quote
// from the transcript. We check the citation against what was actually said / shown:
//   verified   – the quote (or the item's key terms) is found near the cited time or on the cited slide
//   moved      – it is found elsewhere in the lecture; the citation is corrected to that place
//   unsupported – no matching evidence anywhere; the item is shown greyed out with a warning
import { tokens, parseTime } from './text.js';

const NEAR = 60; // seconds around the cited time that count as "at that time"

function bag(toks) { const m = new Map(); for (const t of toks) m.set(t, (m.get(t) || 0) + 1); return m; }

// Share of `need` tokens that appear in `have` (each occurrence counted once).
export function recall(need, have) {
  if (!need.length) return 0;
  const h = bag(have); let hit = 0;
  for (const t of need) { const c = h.get(t); if (c) { hit++; h.set(t, c - 1); } }
  return hit / need.length;
}

function segsBetween(segs, a, b) {
  return segs.filter(s => s.end >= a && s.start <= b);
}

// Find the place in the transcript that best contains `need` (sliding window of ~40s).
function bestPlace(segs, need) {
  let best = { score: 0, t: NaN };
  for (let i = 0; i < segs.length; i++) {
    let j = i, text = '';
    while (j < segs.length && segs[j].start - segs[i].start <= 40) { text += ' ' + segs[j].text; j++; }
    const sc = recall(need, tokens(text));
    if (sc > best.score) best = { score: sc, t: segs[i].start };
  }
  return best;
}

/**
 * @param {{text?:string,q?:string,a?:string,quote?:string,t?:string|number,slide?:number}} item
 * @param {{segs:{start:number,end:number,text:string}[], slides:{text:string}[]}} src
 */
export function checkItem(item, src) {
  const t = parseTime(item.t);
  const quote = tokens(item.quote || '');
  const claim = tokens([item.text, item.q, item.a].filter(Boolean).join(' '));
  const slideIdx = Number.isInteger(item.slide) ? item.slide - 1 : -1;
  const slideText = slideIdx >= 0 && src.slides[slideIdx] ? src.slides[slideIdx].text : '';
  const res = { status: 'unsupported', t: Number.isFinite(t) ? t : null, slide: slideIdx >= 0 && slideText ? item.slide : null, quoteScore: 0, termScore: 0 };

  if (Number.isFinite(t)) {
    const near = tokens(segsBetween(src.segs, t - NEAR, t + NEAR).map(s => s.text).join(' '));
    res.quoteScore = recall(quote, near);
    res.termScore = recall(claim, [...near, ...tokens(slideText)]);
    if ((quote.length >= 3 && res.quoteScore >= 0.7) || (quote.length < 3 && res.termScore >= 0.5)) {
      res.status = 'verified';
    }
  }
  if (res.status !== 'verified') {
    // Wrong or missing time: look for the quote anywhere in the lecture.
    const need = quote.length >= 3 ? quote : claim;
    const place = bestPlace(src.segs, need);
    if (place.score >= (quote.length >= 3 ? 0.7 : 0.6)) {
      res.status = 'moved'; res.movedFrom = res.t; res.t = place.t; res.quoteScore = place.score;
    } else if (slideText && recall(claim, tokens(slideText)) >= 0.6) {
      // Supported by the slide only (e.g. a formula that was written, not said).
      res.status = 'verified'; res.slideOnly = true; res.termScore = recall(claim, tokens(slideText));
    }
  }
  // A cited slide that does not share terms with the item is dropped from the citation.
  if (res.slide && claim.length && recall(claim, tokens(slideText)) < 0.15 && !res.slideOnly) {
    res.slideDropped = res.slide; res.slide = null;
  }
  return res;
}

export function checkPack(pack, src) {
  const stats = { total: 0, verified: 0, moved: 0, unsupported: 0 };
  const visit = it => {
    it.check = checkItem(it, src);
    stats.total++; stats[it.check.status]++;
  };
  for (const sec of pack.sections || []) for (const p of sec.points || []) visit(p);
  for (const c of pack.cards || []) visit(c);
  for (const q of pack.quiz || []) visit(q);
  return stats;
}
