import { createWorker } from 'tesseract.js'; import fs from 'fs'; import path from 'path';
const dir = process.argv[2]; const w = await createWorker('eng', 1, { cachePath: '/workspace/work/gabc/tesscache' });
const out = [];
for (const f of fs.readdirSync(dir).filter(f=>/\.(jpe?g|png)$/.test(f)).sort()) { const { data } = await w.recognize(path.join(dir,f)); out.push({ file: f, conf: data.confidence, text: data.text }); console.error(f, data.confidence); }
fs.writeFileSync(path.join(dir,'ocr.json'), JSON.stringify(out,null,1)); await w.terminate();
