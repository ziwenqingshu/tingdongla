import { createWorker } from 'tesseract.js';
const w = await createWorker('eng', 1, { cachePath: '/workspace/work/gabc/tesscache' });
for (const f of process.argv.slice(2)) {
  const t0 = Date.now();
  const { data } = await w.recognize(f);
  console.log('==', f, 'conf', data.confidence, 'ms', Date.now()-t0); console.log(data.text.slice(0,300));
}
await w.terminate();
