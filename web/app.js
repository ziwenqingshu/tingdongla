// TingDongLa UI: inputs → on-device speech + slide reading → slide matching → AI notes → source check.
import { parseTranscript, fmtTime, escapeHtml, parseTime } from './lib/text.js';
import { cleanSlides } from './lib/slides.js';
import { plan, runPart, runQuiz, stats, outlinePart } from './lib/pipeline.js';
import { PROVIDERS } from './lib/llm.js';
import { I18N } from './lib/i18n.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const S = { audio: null, audioUrl: '', captions: null, slides: [], lang: localStorage.getItem('tdl.ui') || (navigator.language.startsWith('zh') ? 'zh' : 'en'), run: null };
let abort = null;

// ---------- i18n ----------
const t = k => (I18N[S.lang] && I18N[S.lang][k]) || I18N.en[k] || k;
function applyLang() {
  document.documentElement.lang = S.lang === 'zh' ? 'zh-CN' : 'en';
  for (const el of $$('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('#langBtn').textContent = S.lang === 'zh' ? 'English' : '中文';
}
$('#langBtn').onclick = () => { S.lang = S.lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('tdl.ui', S.lang); applyLang(); if (S.run?.done) renderResult(); };

function toast(msg, ms = 4000) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- settings (saved in this browser only) ----------
const prov = $('#optProvider');
for (const [id, p] of Object.entries(PROVIDERS)) prov.add(new Option(p.label, id));
function loadSettings() {
  const s = JSON.parse(localStorage.getItem('tdl.settings') || '{}');
  prov.value = s.provider || 'openrouter';
  $('#optLang').value = s.lang ?? (S.lang === 'zh' ? 'Simplified Chinese (简体中文)' : 'English');
  $('#optAsr').value = s.asr || 'onnx-community/whisper-base';
  $('#optSpeechLang').value = s.speechLang ?? '';
  fillModels(s.model);
  $('#optKey').value = (s.keys || {})[prov.value] || '';
}
function fillModels(model) {
  const p = PROVIDERS[prov.value];
  $('#modelList').innerHTML = p.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
  $('#optModel').value = model && (p.models.includes(model) || !Object.values(PROVIDERS).some(o => o.models.includes(model))) ? model : p.models[0];
  $('#keyLink').href = p.keyUrl;
}
function saveSettings() {
  const s = JSON.parse(localStorage.getItem('tdl.settings') || '{}');
  s.provider = prov.value; s.model = $('#optModel').value.trim(); s.lang = $('#optLang').value;
  s.asr = $('#optAsr').value; s.speechLang = $('#optSpeechLang').value;
  s.keys = { ...(s.keys || {}), [prov.value]: $('#optKey').value.trim() };
  localStorage.setItem('tdl.settings', JSON.stringify(s));
}
prov.onchange = () => { fillModels(); const s = JSON.parse(localStorage.getItem('tdl.settings') || '{}'); $('#optKey').value = (s.keys || {})[prov.value] || ''; saveSettings(); };
for (const id of ['#optModel', '#optKey', '#optLang', '#optAsr', '#optSpeechLang']) $(id).addEventListener('change', saveSettings);
function llmConfig() {
  const p = PROVIDERS[prov.value];
  const key = $('#optKey').value.trim();
  if (!key) return null;
  const model = $('#optModel').value.trim() || p.models[0];
  return { base: p.base, key, model, fallbacks: p.models.filter(m => m !== model) };
}

// ---------- inputs ----------
const CAPTION_RE = /\.(srt|vtt|txt)$/i;
$('#fileAudio').onchange = e => setAudio(e.target.files[0]);
$('#fileSlides').onchange = e => addSlides([...e.target.files]);
for (const [id, fn] of [['#dropAudio', fs => setAudio(fs[0])], ['#dropSlides', fs => addSlides(fs)]]) {
  const el = $(id);
  el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('over'); fn([...e.dataTransfer.files]); });
}
async function setAudio(f) {
  if (!f) return;
  if (CAPTION_RE.test(f.name)) { S.captions = { name: f.name, text: await f.text() }; $('#audioPicked').textContent = `✓ ${f.name} (${t('captions')})`; }
  else {
    if (f.size > 1.5e9) return toast(t('errTooBig'));
    S.audio = f; if (S.audioUrl) URL.revokeObjectURL(S.audioUrl); S.audioUrl = URL.createObjectURL(f);
    $('#audioPicked').textContent = `✓ ${f.name} · ${(f.size / 1e6).toFixed(1)} MB`;
  }
  refreshGo();
}
function addSlides(files) {
  const imgs = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
  // Phone photos are named by time (IMG_1234, 20241120_101500): sort by name, then by modified time.
  imgs.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.lastModified - b.lastModified);
  for (const f of imgs) S.slides.push({ file: f, url: URL.createObjectURL(f), name: f.name });
  renderThumbs(); refreshGo();
}
function renderThumbs() {
  $('#slidesPicked').textContent = S.slides.length ? `✓ ${S.slides.length} ${t('photos')}` : '';
  $('#thumbs').innerHTML = S.slides.map((s, i) => `<figure><img src="${s.url}" alt=""><figcaption>${i + 1}</figcaption><button type="button" data-del="${i}" aria-label="remove">×</button></figure>`).join('');
}
$('#thumbs').onclick = e => { const i = e.target.dataset?.del; if (i != null) { S.slides.splice(+i, 1); renderThumbs(); refreshGo(); } };
function refreshGo() { $('#goBtn').disabled = !(S.audio || S.captions); }

$('#sampleBtn').onclick = async () => {
  $('#sampleBtn').disabled = true;
  try {
    const a = await fetch('sample/econ252-lecture2-excerpt.mp3').then(r => { if (!r.ok) throw 0; return r.blob(); });
    await setAudio(new File([a], 'econ252-lecture2-excerpt.mp3', { type: 'audio/mpeg' }));
    S.slides = [];
    const fs = await Promise.all([1, 2, 3, 4, 5].map(i => fetch(`sample/slide-0${i}.jpg`).then(r => r.blob()).then(b => new File([b], `slide-0${i}.jpg`, { type: 'image/jpeg' }))));
    addSlides(fs);
    $('#optSpeechLang').value = 'en'; saveSettings();
    S.lecture = 'Financial Markets — Lecture 2: Risk and Financial Crises (Yale ECON 252, excerpt)';
    toast(t('sampleLoaded'));
  } catch { toast(t('errSample')); }
  $('#sampleBtn').disabled = false;
};

// ---------- progress UI ----------
let curStage = 'asr';
function stage(name, state, sub, frac) {
  if (state === 'run') curStage = name;
  const li = $(`[data-stage="${name}"]`);
  if (state) li.dataset.state = state;
  if (sub != null) li.querySelector('.sub').textContent = sub;
  const bar = li.querySelector('.bar i'); if (bar && frac != null) bar.style.width = `${Math.round(frac * 100)}%`;
}
function show(step) { for (const id of ['input', 'progress', 'result']) $(`#step-${id}`).hidden = id !== step; window.scrollTo({ top: 0 }); }

// ---------- speech ----------
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try { decoded = await ctx.decodeAudioData(buf); } finally { ctx.close(); }
  const frames = Math.ceil(decoded.duration * 16000);
  const off = new OfflineAudioContext(1, frames, 16000);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const out = await off.startRendering();
  return out.getChannelData(0);
}
function transcribe(audio, model, language, onProgress) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./lib/asr-worker.js', import.meta.url), { type: 'module' });
    const stop = () => { w.terminate(); reject(Object.assign(new Error('cancelled'), { code: 'cancelled', partial: last })); };
    abort?.signal.addEventListener('abort', stop, { once: true });
    let last = [];
    w.onmessage = e => {
      const m = e.data;
      if (m.type === 'download') onProgress({ download: m.loaded / m.total });
      else if (m.type === 'status') onProgress({ status: m.stage, device: m.device, host: m.host });
      else if (m.type === 'progress') { last = m.segs; onProgress({ done: m.done, total: m.total, segs: m.segs }); }
      else if (m.type === 'done') { w.terminate(); resolve(m.segs); }
      else if (m.type === 'error') { w.terminate(); reject(Object.assign(new Error(m.message), { code: m.code, partial: last })); }
    };
    w.onerror = e => { w.terminate(); reject(Object.assign(new Error(e.message || 'worker'), { code: 'asr_crashed', partial: last })); };
    w.postMessage({ id: 1, audio, model, language: language || null }, [audio.buffer]);
  });
}

// ---------- slides ----------
let tesseract = null;
async function ocrSlides(list, onProgress) {
  if (!list.length) return [];
  if (!tesseract) { const m = await import('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.esm.min.js'); tesseract = m.createWorker ? m : m.default; }
  const langs = $('#optSpeechLang').value === 'en' ? 'eng' : 'eng+chi_sim';
  const worker = await tesseract.createWorker(langs, 1);
  const out = [];
  try {
    for (let i = 0; i < list.length; i++) {
      if (abort?.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
      onProgress(i, list.length);
      try {
        const img = await prepImage(list[i].file);
        const { data } = await worker.recognize(img);
        out.push({ text: data.text || '', conf: data.confidence });
      } catch { out.push({ text: '', conf: 0, failed: true }); }
    }
  } finally { await worker.terminate(); }
  onProgress(list.length, list.length);
  return out;
}
// Scale to ~2000 px on the long side and convert to grayscale: phone photos are often 4000 px
// (slow) and colour backgrounds lower Tesseract's accuracy.
async function prepImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.2)'; g.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

// ---------- main run ----------
$('#goBtn').onclick = () => start();
$('#cancelBtn').onclick = () => abort?.abort();
$('#restartBtn').onclick = () => { S.run = null; show('input'); };

async function start() {
  saveSettings();
  abort = new AbortController();
  for (const li of $$('#stages li')) { li.dataset.state = 'wait'; li.querySelector('.sub').textContent = ''; const b = li.querySelector('.bar i'); if (b) b.style.width = '0'; }
  $('#partChips').innerHTML = '';
  show('progress');
  const run = S.run = { segs: [], slidesRaw: [], slides: [], parts: [], quiz: null, warnings: [], audioUrl: S.audioUrl, slideUrls: S.slides.map(s => s.url), lecture: S.lecture || (S.audio?.name || S.captions?.name || '').replace(/\.[^.]+$/, '') };
  try {
    // 1. transcript
    if (S.captions) {
      run.segs = parseTranscript(S.captions.text);
      if (!run.segs.length) throw Object.assign(new Error(t('errCaptions')), { code: 'captions_empty', stage: 'asr' });
      stage('asr', 'ok', `${t('fromCaptions')} · ${run.segs.length} ${t('lines')}`, 1);
    } else {
      stage('asr', 'run', t('decoding'));
      let audio;
      try { audio = await decodeAudio(S.audio); } catch { throw Object.assign(new Error(t('errDecode')), { code: 'decode', stage: 'asr' }); }
      if (audio.length < 16000 * 3) throw Object.assign(new Error(t('errShort')), { code: 'too_short', stage: 'asr' });
      run.duration = audio.length / 16000;
      const t0 = performance.now();
      try {
        run.segs = await transcribe(audio, $('#optAsr').value, $('#optSpeechLang').value, p => {
          if (p.download != null) stage('asr', 'run', `${t('downloadModel')} ${Math.round(p.download * 100)}%`, p.download);
          else if (p.status === 'ready') stage('asr', 'run', `${t('modelReady')} (${p.device})`, 0);
          else if (p.total) {
            const el = (performance.now() - t0) / 1000, eta = el / p.done * (p.total - p.done);
            stage('asr', 'run', `${fmtTime(p.done)} / ${fmtTime(p.total)} · ${t('left')} ~${fmtTime(eta)} · “${(p.segs.at(-1)?.text || '').slice(0, 60)}”`, p.done / p.total);
          }
        });
      } catch (e) {
        if (e.code === 'cancelled' && e.partial?.length) { run.segs = e.partial; run.warnings.push(t('warnPartialAsr')); }
        else if (e.code === 'cancelled') throw e;
        else if (e.partial?.length) { run.segs = e.partial; run.warnings.push(`${t('warnAsrStopped')} ${fmtTime(e.partial.at(-1).end)}.`); }
        else throw Object.assign(new Error(e.code === 'model_host_unreachable' ? t('errModelHost') : t('errAsr')), { code: e.code, stage: 'asr' });
      }
      if (!run.segs.length) throw Object.assign(new Error(t('errNoSpeech')), { code: 'no_speech', stage: 'asr' });
      stage('asr', 'ok', `${run.segs.length} ${t('lines')} · ${fmtTime(run.duration)} · ${Math.round((performance.now() - t0) / 1000)} s`, 1);
    }
    // 2. slides
    if (S.slides.length) {
      stage('ocr', 'run');
      run.slidesRaw = await ocrSlides(S.slides, (i, n) => stage('ocr', 'run', `${i} / ${n}`, i / n));
      run.slides = cleanSlides(run.slidesRaw);
      const bad = run.slides.map((s, i) => s.readable ? null : i + 1).filter(Boolean);
      if (bad.length) run.warnings.push(`${t('warnUnreadable')} ${bad.join(', ')}.`);
      stage('ocr', bad.length ? 'warn' : 'ok', `${run.slides.length - bad.length}/${run.slides.length} ${t('readable')}${bad.length ? ` · ${t('lowText')}: ${bad.join(', ')}` : ''}`, 1);
    } else stage('ocr', 'skip', t('noSlides'));
    // 3. align
    const p = plan(run.segs, run.slides);
    run.parts = p.parts; run.ranges = p.ranges; run.wins = p.wins; run.assign = p.assign;
    const matched = p.ranges.filter(r => r.length).length;
    stage('align', 'ok', S.slides.length ? `${matched}/${run.slides.length} ${t('slidesMatched')} · ${run.parts.length} ${t('parts')}` : `${run.parts.length} ${t('parts')}`);
    // 4. AI
    const cfg = llmConfig();
    $('#partChips').innerHTML = run.parts.map((pt, i) => `<span class="chip" data-i="${i}">${fmtTime(pt.start)}</span>`).join('');
    const ctx = { cfg, segs: run.segs, slides: run.slides, meta: { lecture: run.lecture, lang: $('#optLang').value }, total: run.parts.length, signal: abort.signal };
    run.ctx = ctx;
    if (!cfg) {
      for (const pt of run.parts) { pt.result = outlinePart(pt, run.segs, run.slides); pt.status = 'nokey'; }
      stage('llm', 'skip', t('noKeyOutline'));
    } else {
      stage('llm', 'run', `0 / ${run.parts.length}`);
      for (let i = 0; i < run.parts.length; i++) {
        if (abort.signal.aborted) break;
        const chip = $(`#partChips [data-i="${i}"]`); chip.dataset.state = 'run';
        await runPart(run.parts[i], { ...ctx, onAttempt: a => toast(`${t('retrying')} (${a.code})`) });
        chip.dataset.state = run.parts[i].status;
        stage('llm', 'run', `${i + 1} / ${run.parts.length}${run.parts[i].result.model ? ' · ' + run.parts[i].result.model : ''}`);
      }
      const failed = run.parts.filter(x => x.status === 'failed').length;
      if (!abort.signal.aborted) {
        stage('llm', 'run', t('writingQuiz'));
        run.quiz = await runQuiz(run.parts, ctx);
      }
      stage('llm', failed ? 'warn' : 'ok', failed ? `${failed} ${t('partsFailed')}` : `${run.parts.length} ${t('parts')} · ${t('quiz')}: ${run.quiz?.quiz?.length || 0}`);
      if (failed) run.warnings.push(`${failed} ${t('warnPartsFailed')}`);
    }
    // 5. check (done per item in pipeline; summarise)
    const st = stats(run.parts, run.quiz);
    stage('check', 'ok', st.total ? `${st.verified} ${t('verified')} · ${st.moved} ${t('moved')} · ${st.unsupported} ${t('unsupported')}` : '—');
    run.done = true;
    renderResult(); show('result');
  } catch (e) {
    const where = e.stage || curStage;
    stage(where, 'fail', e.code === 'cancelled' ? t('cancelled') : e.message);
    toast(e.code === 'cancelled' ? t('cancelled') : e.message, 8000);
    $('#cancelBtn').textContent = t('back'); $('#cancelBtn').onclick = () => { $('#cancelBtn').textContent = t('cancel'); $('#cancelBtn').onclick = () => abort?.abort(); show('input'); };
  }
}

// ---------- results ----------
function cite(it) {
  const c = it.check || {};
  const tm = c.t != null ? c.t : (!it.check && Number.isFinite(parseTime(it.t)) ? parseTime(it.t) : null);
  const slide = c.slide ?? (it.check ? null : it.slide);
  const cls = c.status || 'none';
  const label = { verified: t('bVerified'), moved: t('bMoved'), unsupported: t('bUnsupported') }[cls] || '';
  return `<span class="cite ${cls}">${tm != null ? `<button type="button" class="tag time" data-t="${tm}" data-q="${escapeHtml(it.quote || '')}" data-s="${slide || ''}" data-st="${cls}">▶ ${fmtTime(tm)}</button>` : ''}${slide ? `<button type="button" class="tag slide" data-t="${tm ?? ''}" data-q="${escapeHtml(it.quote || '')}" data-s="${slide}" data-st="${cls}">▣ ${t('slide')} ${slide}</button>` : ''}${label ? `<span class="badge ${cls}" title="${escapeHtml(t('h_' + cls))}">${label}</span>` : ''}</span>`;
}
function renderResult() {
  const run = S.run; if (!run) return;
  const st = stats(run.parts, run.quiz);
  $('#packTitle').textContent = run.lecture || t('packTitle');
  $('#checkLine').innerHTML = (st.total
    ? `<b>${st.total}</b> ${t('items')} · <span class="ok">${st.verified} ${t('verified')}</span> · <span class="mv">${st.moved} ${t('moved')}</span> · <span class="un">${st.unsupported} ${t('unsupported')}</span>`
    : t('outlineOnly')) + run.warnings.map(w => `<br><span class="warn">⚠ ${escapeHtml(w)}</span>`).join('');
  renderTimeline(run);
  // notes
  $('#tab-notes').innerHTML = run.parts.map((p, i) => {
    const r = p.result; if (!r) return '';
    const failed = p.status === 'failed';
    return `<article class="part ${p.status}">
      <header><span class="range">${fmtTime(p.start)}–${fmtTime(p.end)}</span><h3>${escapeHtml(r.title)}</h3>
      ${p.slides.length ? `<span class="slides">${p.slides.map(n => `<button type="button" class="tag slide" data-s="${n}" data-t="${p.start}">▣ ${n}</button>`).join('')}</span>` : ''}</header>
      ${failed ? `<div class="notice">${t('partFailed')} (${escapeHtml(p.error?.code || '')}) <button type="button" class="ghost small" data-retry="${i}">${t('retry')}</button></div>` : ''}
      ${p.status === 'nokey' ? `<div class="notice">${t('outlineNotice')}</div>` : ''}
      <ul>${r.points.map(x => `<li class="${x.check?.status || ''}"><span class="txt">${escapeHtml(x.text)}</span>${cite(x)}</li>`).join('')}</ul>
    </article>`;
  }).join('');
  // cards
  const cards = run.parts.flatMap(p => p.status === 'done' ? p.result.cards : []);
  $('#tab-cards').innerHTML = cards.length ? `<div class="cards">${cards.map(c => `<div class="fc ${c.check?.status || ''}" tabindex="0"><div class="q">${escapeHtml(c.q)}</div><div class="a">${escapeHtml(c.a)}</div>${cite(c)}<small class="flip">${t('tapFlip')}</small></div>`).join('')}</div>` : `<p class="hint">${t('noCards')}</p>`;
  // quiz
  const qz = run.quiz?.quiz || [];
  $('#tab-quiz').innerHTML = qz.length ? qz.map((q, i) => `<div class="qz ${q.check?.status || ''}" data-a="${q.answer}"><p><b>${i + 1}.</b> ${escapeHtml(q.q)}</p>${q.options.map((o, j) => `<button type="button" class="opt" data-j="${j}">${'ABCDE'[j]}. ${escapeHtml(o)}</button>`).join('')}<div class="explain" hidden>${escapeHtml(q.explain)} ${cite(q)}</div></div>`).join('')
    : `<p class="hint">${run.quiz?.status === 'failed' ? t('quizFailed') : t('noQuiz')}</p>`;
  // transcript
  $('#tab-transcript').innerHTML = `<div class="tx">${run.segs.map(s => `<p><button type="button" class="tag time" data-t="${s.start}" data-q="">${fmtTime(s.start)}</button> ${escapeHtml(s.text)}</p>`).join('')}</div>`;
}
function renderTimeline(run) {
  const dur = run.segs.at(-1)?.end || 1;
  const lanes = run.ranges?.map((rs, i) => rs.map(r => `<button type="button" class="seg" style="left:${r.start / dur * 100}%;width:${Math.max(0.6, (r.end - r.start) / dur * 100)}%" data-s="${i + 1}" data-t="${r.start}" title="${t('slide')} ${i + 1}: ${escapeHtml(run.slides[i]?.title || '')} · ${fmtTime(r.start)}–${fmtTime(r.end)}">${i + 1}</button>`).join('')).join('') || '';
  const parts = run.parts.map(p => `<span class="pmark" style="left:${p.start / dur * 100}%"></span>`).join('');
  $('#timeline').innerHTML = `<div class="tl-label">${t('timeline')}</div><div class="tl">${parts}${lanes}</div><div class="tl-axis"><span>0:00</span><span>${fmtTime(dur / 2)}</span><span>${fmtTime(dur)}</span></div>`;
}

// tabs
$('.tabs').onclick = e => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  for (const x of $$('.tabs [data-tab]')) x.setAttribute('aria-selected', x === b);
  for (const x of $$('.tab')) x.hidden = x.id !== `tab-${b.dataset.tab}`;
};
// source panel, quiz answers, card flip, retry
document.addEventListener('click', async e => {
  const tag = e.target.closest('.tag');
  if (tag && S.run) { openSource(tag.dataset); return; }
  const opt = e.target.closest('.opt');
  if (opt) { const box = opt.closest('.qz'); const right = +box.dataset.a === +opt.dataset.j; opt.classList.add(right ? 'right' : 'wrong'); box.querySelector(`[data-j="${box.dataset.a}"]`).classList.add('right'); box.querySelector('.explain').hidden = false; return; }
  const fc = e.target.closest('.fc'); if (fc) { fc.classList.toggle('flipped'); return; }
  const rt = e.target.closest('[data-retry]');
  if (rt && S.run) {
    rt.disabled = true; rt.textContent = t('retrying');
    const cfg = llmConfig(); if (!cfg) { toast(t('needKey')); return; }
    abort = new AbortController();
    await runPart(S.run.parts[+rt.dataset.retry], { ...S.run.ctx, cfg, signal: abort.signal });
    renderResult();
  }
});
function openSource(d) {
  const run = S.run;
  $('#sourceHint').hidden = true; $('#sourceBody').hidden = false;
  const tm = d.t !== '' && d.t != null ? +d.t : null;
  const st = d.st || '';
  $('#srcStatus').className = `src-status ${st}`;
  $('#srcStatus').textContent = st ? t('h_' + st) : '';
  const player = $('#player');
  if (run.audioUrl) {
    if (player.src !== run.audioUrl) player.src = run.audioUrl;
    player.hidden = false;
    if (tm != null) { player.currentTime = Math.max(0, tm - 1); player.play().catch(() => {}); }
  } else player.hidden = true;
  // transcript excerpt around the time, quote highlighted
  if (tm != null) {
    const near = run.segs.filter(s => s.end >= tm - 12 && s.start <= tm + 25);
    let html = near.map(s => `<span class="ts">${fmtTime(s.start)}</span> ${escapeHtml(s.text)}`).join(' ');
    const q = (d.q || '').trim();
    if (q.length > 8) {
      const words = q.split(/\s+/).slice(0, 6).map(w => w.replace(/[^\p{L}\p{N}']/gu, '')).filter(Boolean);
      if (words.length >= 2) html = html.replace(new RegExp(`(${words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+')})`, 'iu'), '<mark>$1</mark>');
    }
    $('#srcText').innerHTML = html; $('#srcText').hidden = false;
  } else $('#srcText').hidden = true;
  const sn = d.s ? +d.s : null;
  const fig = $('#srcSlide');
  if (sn && run.slideUrls[sn - 1]) {
    fig.hidden = false; fig.querySelector('img').src = run.slideUrls[sn - 1];
    const r = run.ranges?.[sn - 1] || [];
    fig.querySelector('figcaption').textContent = `${t('slide')} ${sn}${run.slides[sn - 1]?.title ? ' · ' + run.slides[sn - 1].title : ''}${r.length ? ' · ' + t('shownAt') + ' ' + r.map(x => fmtTime(x.start)).join(', ') : ''}`;
  } else fig.hidden = true;
  if (window.innerWidth < 900) $('#source').scrollIntoView({ behavior: 'smooth' });
}

// ---------- export ----------
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('#exportMd').onclick = () => {
  const run = S.run; const L = [`# ${run.lecture || 'Review pack'}`, ''];
  for (const p of run.parts) {
    L.push(`## ${p.result.title} (${fmtTime(p.start)}–${fmtTime(p.end)})`);
    for (const x of p.result.points) L.push(`- ${x.text} — [${x.check?.t != null ? fmtTime(x.check.t) : x.t}${x.check?.slide ? `, slide ${x.check.slide}` : ''}]${x.check?.status === 'unsupported' ? ' ⚠ no source found' : ''}`);
    L.push('');
  }
  const qz = run.quiz?.quiz || [];
  if (qz.length) { L.push('## Quiz'); qz.forEach((q, i) => { L.push(`${i + 1}. ${q.q}`); q.options.forEach((o, j) => L.push(`   - ${'ABCDE'[j]}. ${o}${j === q.answer ? ' ✓' : ''}`)); }); }
  download('review-pack.md', L.join('\n'), 'text/markdown');
};
$('#exportAnki').onclick = () => {
  const cards = S.run.parts.flatMap(p => p.status === 'done' ? p.result.cards : []).filter(c => c.check?.status !== 'unsupported');
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  download('flashcards.csv', cards.map(c => [esc(c.q), esc(`${c.a} (${c.check?.t != null ? fmtTime(c.check.t) : c.t})`)].join(',')).join('\n'), 'text/csv');
};

loadSettings(); applyLang();
