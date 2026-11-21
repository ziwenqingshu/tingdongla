import { cleanSlides } from '../web/lib/slides.js';
import fs from 'fs';
const d = JSON.parse(fs.readFileSync(process.argv[2]));
const c = cleanSlides(d.map(x => ({ text: x.text, conf: x.conf })));
c.forEach((s, i) => console.log(i + 1, s.readable ? 'OK ' : 'LOW', '|', s.title, '|', s.text.replace(/\n/g, ' / ').slice(0, 120), '| removed', s.removed));
