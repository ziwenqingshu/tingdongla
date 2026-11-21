// Speech-to-text in a Web Worker, entirely on the student's device (audio never leaves it).
// Whisper via transformers.js (ONNX Runtime Web): WebGPU when available, otherwise WASM.
// Model files come from Hugging Face; if that host is unreachable (common on campus networks
// in mainland China) we switch to the hf-mirror.com mirror automatically.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

env.allowLocalModels = false;
const HOSTS = ['https://huggingface.co/', 'https://hf-mirror.com/'];
let asr = null, loadedKey = '';

async function reachable(host, model) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const r = await fetch(`${host}${model}/resolve/main/config.json`, { signal: ctl.signal, cache: 'no-store' });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

async function load(model, post) {
  const key = model;
  if (asr && loadedKey === key) return;
  let host = null;
  for (const h of HOSTS) { if (await reachable(h, model)) { host = h; break; } }
  if (!host) throw Object.assign(new Error('model_host_unreachable'), { code: 'model_host_unreachable' });
  env.remoteHost = host;
  post({ type: 'status', stage: 'model', host });
  const device = (typeof navigator !== 'undefined' && navigator.gpu && await navigator.gpu.requestAdapter().catch(() => null)) ? 'webgpu' : 'wasm';
  const files = new Map();
  asr = await pipeline('automatic-speech-recognition', model, {
    device,
    dtype: device === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
    progress_callback: p => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, [p.loaded, p.total]);
        let a = 0, b = 0; for (const [x, y] of files.values()) { a += x; b += y; }
        post({ type: 'download', loaded: a, total: b });
      }
    },
  });
  loadedKey = key;
  post({ type: 'status', stage: 'ready', device });
}

self.onmessage = async (e) => {
  const { id, audio, model = 'onnx-community/whisper-base', language = null, offset = 0 } = e.data;
  const post = m => self.postMessage({ id, ...m });
  try {
    await load(model, post);
    // Transcribe in 30 s chunks and report each chunk as soon as it is done, so long
    // lectures show progress and a crash halfway keeps the part already transcribed.
    const SR = 16000, CH = 30 * SR, STEP = 28 * SR;
    const segs = [];
    for (let s = 0; s < audio.length; s += STEP) {
      const part = audio.subarray(s, Math.min(audio.length, s + CH));
      if (part.length < SR * 0.5) break;
      const out = await asr(part, {
        return_timestamps: true,
        ...(language ? { language, task: 'transcribe' } : {}),
      });
      const base = offset + s / SR;
      for (const c of out.chunks || []) {
        const [a, b] = c.timestamp;
        const start = base + (a ?? 0), end = base + (b ?? (a ?? 0) + 5);
        // Overlap (2 s) between chunks: skip text we already have.
        if (segs.length && start < segs[segs.length - 1].end - 0.5) continue;
        const text = (c.text || '').trim();
        if (text && !/^\[.*\]$|^\(.*\)$/.test(text)) segs.push({ start, end, text });
      }
      post({ type: 'progress', done: Math.min(audio.length, s + CH) / SR, total: audio.length / SR, segs: segs.slice() });
    }
    post({ type: 'done', segs });
  } catch (err) {
    post({ type: 'error', code: err.code || 'asr_failed', message: String(err.message || err).slice(0, 200) });
  }
};
