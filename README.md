# TingDongLa 听懂啦

**Lecture recording + phone photos of the slides → notes, flashcards and a quiz where every line links back to the second it was said and the slide it was on.**

Built from scratch for the [Global AI Builder's Challenge](https://global-ai-builders-challenge.devpost.com/) (Nov 21–28, 2026).

> Status: work in progress during the hackathon. This README is updated as the project develops.

## Why

Students review for exams from two messy sources: a 50–90 minute recording and a camera roll of blurry slide photos. AI summarisers turn that into neat notes, but the student cannot tell which lines are real and has to scrub through the audio to check. TingDongLa makes every generated item checkable in one tap, and checks it automatically first.

## How it works

1. **Speech → text, on the device.** Whisper (base or tiny) runs in the browser through transformers.js / ONNX Runtime Web (WebGPU if available, else WASM). Audio never leaves the device. Already have captions? Upload `.srt` / `.vtt` / `.txt` instead.
2. **Slide photos → text, on the device.** Tesseract.js OCR (English + Simplified Chinese). Lines repeated on most slides (logos, licence footers) and OCR junk are removed before use.
3. **Slides ↔ recording.** TF-IDF similarity between each slide and each 45-second stretch of the transcript, with a monotonic dynamic program (lectures move forward through the deck). Result: a timeline of where each slide was discussed.
4. **AI writes the pack, part by part.** The lecture is split into ~5-minute parts at slide changes. For each part, an LLM gets only the transcript lines (with times) and that part's slide text, and must return JSON where every item cites a time, a slide and a **verbatim quote**. A final call writes the quiz from the key points.
5. **Every item is checked.** The quote is searched for in the transcript around the cited time. Found → *source ✓*. Found elsewhere → the link is *corrected*. Not found → *⚠ no source*, shown greyed out.
6. **Failures keep what worked.** A failed or rate-limited AI call falls back to the next model, then to a transcript outline for that part only, with a Retry button. Stopping transcription early keeps the transcribed part.

## Run it

It is a static site — no build step, no server.

```bash
git clone https://github.com/ziwenqingshu/tingdongla
cd tingdongla/web
python3 -m http.server 8000   # then open http://localhost:8000
```

In **Settings**, choose an AI provider and paste your own API key (stored only in your browser's localStorage and sent only to that provider):

| Provider | Default model | Key |
|---|---|---|
| OpenRouter | `nvidia/nemotron-3-ultra-550b-a55b:free` (free tier, 50 requests/day), falls back to `google/gemma-4-31b-it:free` | https://openrouter.ai/settings/keys |
| Alibaba Model Studio (Qwen) | `qwen-flash` | https://bailian.console.aliyun.com/ |
| DeepSeek | `deepseek-chat` | https://platform.deepseek.com/api_keys |

Without a key you still get the transcript, slide matching and an outline.

### Third-party dependencies (loaded from jsDelivr at runtime)

- [@huggingface/transformers](https://github.com/huggingface/transformers.js) 3.8.1 (Apache-2.0) + Whisper ONNX weights from `onnx-community/whisper-base` / `whisper-tiny` on Hugging Face (falls back to the hf-mirror.com mirror if Hugging Face is unreachable)
- [tesseract.js](https://github.com/naptha/tesseract.js) 5.1.1 (Apache-2.0)

### Tests

```bash
cd tools && npm install            # transformers + tesseract for Node-side tests
node ../tests/slides.test.mjs <ocr.json>
node ../tests/align_run.mjs <asr.json> <ocr.json>
node ../tests/pack_run.mjs <asr.json> <ocr.json> <model> all English out.json   # needs an OpenRouter key file
python3 tools/e2e.py runs/sample --sample   # full browser run with Playwright
```

## Sample data

`web/sample/` holds a 13-minute excerpt of Yale ECON 252 Lecture 2 (Robert Shiller) and five slide photos, from Open Yale Courses under CC BY-NC-SA 3.0. See `web/sample/README.md`.

## Development & AI disclosure

- New project, started on Nov 21, 2026 (the first day of the hackathon). No code existed before.
- Team: Zhixin Qin (solo). The code, tests and documentation were written mainly by the AI assistant **Hark**, working on Zhixin's behalf; Zhixin chose the idea and the scope. Every AI-written component was run against real lecture data and the results were checked before it was kept (see the project description for the specific checks).
- AI inside the product: Whisper (speech recognition, on device), Tesseract (OCR, not a generative model), and the LLM the user selects (notes, flashcards, quiz).

## Licence

Code: MIT. Sample lecture files: CC BY-NC-SA 3.0 (see above).
