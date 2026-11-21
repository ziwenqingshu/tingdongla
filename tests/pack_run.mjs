// Usage: node tests/pack_run.mjs <asr.json> <ocr.json> <model> <partIndexes comma|all> [lang] [out.json]
import fs from 'fs';
import { cleanSlides } from '../web/lib/slides.js';
import { plan, runPart, runQuiz, stats } from '../web/lib/pipeline.js';
import { fmtTime } from '../web/lib/text.js';
const [asrFile, ocrFile, model, which = '2', lang = 'English', outFile = '/tmp/pack.json'] = process.argv.slice(2);
const key = fs.readFileSync('/workspace/work/gabc/secrets/openrouter.key', 'utf8').trim();
const cfg = { base: 'https://openrouter.ai/api/v1', key, model };
const asr = JSON.parse(fs.readFileSync(asrFile));
const segs = asr.chunks.map(c => ({ start: c.timestamp[0], end: c.timestamp[1] ?? c.timestamp[0] + 5, text: c.text }));
const slides = cleanSlides(JSON.parse(fs.readFileSync(ocrFile)).map(x => ({ text: x.text, conf: x.conf })));
const p = plan(segs, slides);
const idx = which === 'all' ? p.parts.map((_, i) => i) : which.split(',').map(Number);
const ctx = { cfg, segs, slides, meta: { lecture: process.env.LECTURE || 'Lecture', lang }, total: p.parts.length };
for (const i of idx) {
  const part = await runPart(p.parts[i], ctx);
  console.log(`\n## part ${i + 1} ${fmtTime(part.start)}-${fmtTime(part.end)} ${part.status} ${part.result.ms || ''}ms ${part.error ? JSON.stringify(part.error) : ''}`);
  console.log('#', part.result.title);
  for (const x of [...part.result.points, ...part.result.cards]) console.log(`- [${x.check?.status}${x.check?.status === 'moved' ? ' ' + x.t + '→' + fmtTime(x.check.t) : ''}] ${x.text || x.q + ' => ' + x.a} | t=${x.t} s=${x.slide} q="${x.quote}" qs=${x.check?.quoteScore?.toFixed(2)}`);
}
let quiz = null;
if (process.env.QUIZ) { quiz = await runQuiz(p.parts, ctx); console.log('\nQUIZ', quiz.status, JSON.stringify(quiz.error || ''));
  for (const q of quiz.quiz) console.log(`- [${q.check.status}] ${q.q} | ${q.options[q.answer]} | t=${q.t}`); }
console.log('\nSTATS', JSON.stringify(stats(p.parts, quiz)));
fs.writeFileSync(outFile, JSON.stringify({ parts: p.parts.map(({ wins, ...r }) => r), quiz }, null, 1));
