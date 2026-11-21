"""End-to-end run of the real web app in headless Chromium (used for tests, screenshots and the demo video).

python3 tools/e2e.py <out_prefix> [--sample | --audio FILE --slides DIR] [--lang English] [--fail-llm] [--no-key] [--record]

The sandbox this was developed in blocks direct browser traffic, so every external request
(jsDelivr, Hugging Face, the LLM API) is fetched by Python and handed to the page. Hugging Face
model files are served from a local cache when present. The API key is read from
$TDL_KEY_FILE and injected into the page's localStorage; it is never written to the repo.
"""
import os, sys, json, time, argparse, hashlib, mimetypes, urllib.request, urllib.error, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent / 'web'
CACHE = pathlib.Path(os.environ.get('TDL_NETCACHE', '/workspace/work/gabc/netcache'))
HF = pathlib.Path(os.environ.get('TDL_HFCACHE', '/workspace/work/gabc/hfcache'))
CACHE.mkdir(parents=True, exist_ok=True)
ap = argparse.ArgumentParser()
ap.add_argument('out'); ap.add_argument('--sample', action='store_true'); ap.add_argument('--audio'); ap.add_argument('--slides')
ap.add_argument('--captions'); ap.add_argument('--lang', default='English'); ap.add_argument('--speech-lang', default='en')
ap.add_argument('--fail-llm', action='store_true'); ap.add_argument('--fail-llm-after', type=int, default=-1)
ap.add_argument('--no-key', action='store_true'); ap.add_argument('--record', action='store_true'); ap.add_argument('--ui', default='en')
ap.add_argument('--model', default=''); ap.add_argument('--timeout', type=int, default=3600); ap.add_argument('--width', type=int, default=1360)
ap.add_argument('--block-hf', action='store_true')
a = ap.parse_args()
key = '' if a.no_key else pathlib.Path(os.environ.get('TDL_KEY_FILE', '/workspace/work/gabc/secrets/openrouter.key')).read_text().strip()
log = []
llm_calls = {'n': 0}

def fetch(url, method='GET', headers=None, body=None):
    h = {k: v for k, v in (headers or {}).items() if k.lower() in ('content-type', 'authorization', 'accept', 'x-title', 'range')}
    req = urllib.request.Request(url, data=body, method=method, headers={**h, 'User-Agent': 'Mozilla/5.0 TingDongLa-e2e'})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()

def handle(route, req):
    url = req.url
    if url.startswith('http://app.local/'):
        p = ROOT / url.split('http://app.local/', 1)[1].split('?')[0]
        if p.is_dir(): p = p / 'index.html'
        if not p.exists(): return route.fulfill(status=404, body='nf')
        return route.fulfill(status=200, body=p.read_bytes(), headers={'Content-Type': mimetypes.guess_type(str(p))[0] or 'application/octet-stream', 'Access-Control-Allow-Origin': '*'})
    cors = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'}
    if req.method == 'OPTIONS':
        return route.fulfill(status=204, headers=cors)
    if ('huggingface.co' in url or 'hf-mirror.com' in url):
        if a.block_hf: return route.abort('connectionrefused')
        # https://huggingface.co/<org>/<model>/resolve/main/<file>
        try:
            rest = url.split('.co/', 1)[1] if 'huggingface.co' in url else url.split('.com/', 1)[1]
            org, model, _, _, *f = rest.split('?')[0].split('/')
            lp = HF / org / model / '/'.join(f)
            if lp.exists():
                return route.fulfill(status=200, body=lp.read_bytes(), headers={**cors, 'Content-Type': 'application/octet-stream'})
        except Exception: pass
    if 'openrouter.ai' in url or 'dashscope' in url or 'deepseek' in url:
        llm_calls['n'] += 1
        if a.fail_llm or (a.fail_llm_after >= 0 and llm_calls['n'] > a.fail_llm_after):
            log.append({'llm': url, 'injected_failure': True, 't': time.time()})
            return route.fulfill(status=503, body='{"error":{"message":"injected outage for testing"}}', headers={**cors, 'Content-Type': 'application/json'})
        t0 = time.time()
        st, hd, body = fetch(url, req.method, req.headers, req.post_data_buffer)
        log.append({'llm': url, 'status': st, 'sec': round(time.time() - t0, 1), 'req_bytes': len(req.post_data_buffer or b''), 'reply': body[:3000].decode('utf8', 'replace'), 'request': (req.post_data_buffer or b'')[:200000].decode('utf8', 'replace')})
        return route.fulfill(status=st, body=body, headers={**cors, 'Content-Type': hd.get('Content-Type', 'application/json')})
    if req.method == 'GET':
        cp = CACHE / hashlib.sha1(url.encode()).hexdigest()
        if cp.exists():
            meta = json.loads((cp.with_suffix('.json')).read_text())
            return route.fulfill(status=200, body=cp.read_bytes(), headers={**cors, 'Content-Type': meta['ct']})
        st, hd, body = fetch(url, 'GET', req.headers)
        if st == 200:
            cp.write_bytes(body); cp.with_suffix('.json').write_text(json.dumps({'url': url, 'ct': hd.get('Content-Type', 'application/octet-stream')}))
        return route.fulfill(status=st, body=body, headers={**cors, 'Content-Type': hd.get('Content-Type', 'application/octet-stream')})
    st, hd, body = fetch(url, req.method, req.headers, req.post_data_buffer)
    return route.fulfill(status=st, body=body, headers={**cors, 'Content-Type': hd.get('Content-Type', 'application/json')})

out = pathlib.Path(a.out); out.parent.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': a.width, 'height': 860}, device_scale_factor=1, locale='en-US',
                        record_video_dir=str(out.parent / (out.name + '-video')) if a.record else None,
                        record_video_size={'width': a.width, 'height': 860} if a.record else None)
    settings = {'provider': 'openrouter', 'lang': a.lang, 'speechLang': a.speech_lang, 'keys': {'openrouter': key}}
    if a.model: settings['model'] = a.model
    ctx.add_init_script(f"try{{localStorage.setItem('tdl.settings', {json.dumps(json.dumps(settings))}); localStorage.setItem('tdl.ui', {json.dumps(a.ui)});}}catch(e){{}}")
    ctx.route('**/*', handle)
    pg = ctx.new_page()
    pg.on('console', lambda m: log.append({'console': m.type, 'text': m.text[:400]}) if m.type in ('error', 'warning') else None)
    pg.on('pageerror', lambda e: log.append({'pageerror': str(e)[:400]}))
    pg.on('crash', lambda *_: print('PAGE CRASHED', flush=True))
    pg.on('console', lambda m: print('console', m.type, m.text[:300], flush=True))
    pg.goto('http://app.local/index.html'); pg.wait_for_timeout(800)
    pg.screenshot(path=f'{a.out}-1-start.png')
    if a.sample:
        pg.click('#sampleBtn'); pg.wait_for_function('!document.querySelector("#goBtn").disabled', timeout=60000)
    else:
        if a.audio: pg.set_input_files('#fileAudio', a.audio)
        if a.captions: pg.set_input_files('#fileAudio', a.captions)
        if a.slides:
            files = sorted(str(x) for x in pathlib.Path(a.slides).iterdir() if x.suffix.lower() in ('.jpg', '.jpeg', '.png'))
            pg.set_input_files('#fileSlides', files)
    pg.wait_for_timeout(500); pg.screenshot(path=f'{a.out}-2-ready.png')
    t0 = time.time(); pg.click('#goBtn')
    shots = 0
    while time.time() - t0 < a.timeout:
        pg.wait_for_timeout(5000)
        try:
            print(round(time.time()-t0), pg.evaluate("[...document.querySelectorAll('[data-stage]')].map(li=>li.dataset.stage+':'+li.dataset.state+':'+li.querySelector('.sub').textContent.slice(0,80)).join(' | ')"), flush=True)
        except Exception as e:
            print('dead', e, json.dumps(log[-5:]), flush=True); raise
        if not pg.is_hidden('#step-result'): break
        if pg.locator('[data-stage][data-state="fail"]').count(): break
        if shots < 3 and time.time() - t0 > 20 * (shots + 1): pg.screenshot(path=f'{a.out}-3-progress{shots}.png'); shots += 1
    elapsed = round(time.time() - t0)
    stages = pg.evaluate("[...document.querySelectorAll('[data-stage]')].map(li=>({stage:li.dataset.stage,state:li.dataset.state,sub:li.querySelector('.sub').textContent}))")
    pg.screenshot(path=f'{a.out}-4-end.png', full_page=False)
    result = None
    if not pg.is_hidden('#step-result'):
        pg.screenshot(path=f'{a.out}-5-notes.png', full_page=True)
        tags = pg.locator('#tab-notes .tag.time')
        if tags.count() > 1: tags.nth(1).click(); pg.wait_for_timeout(800); pg.screenshot(path=f'{a.out}-6-source.png')
        for tab in ('cards', 'quiz'):
            pg.click(f'.tabs [data-tab="{tab}"]'); pg.wait_for_timeout(300); pg.screenshot(path=f'{a.out}-7-{tab}.png', full_page=True)
        pg.click('.tabs [data-tab="notes"]')
        result = pg.evaluate("""() => { const r = window.__tdl_run || null; return { check: document.querySelector('#checkLine').innerText,
           parts: [...document.querySelectorAll('#tab-notes .part')].map(p => ({cls: p.className, title: p.querySelector('h3').innerText, items: [...p.querySelectorAll('li')].map(li => li.innerText)})),
           quiz: [...document.querySelectorAll('.qz')].map(q => q.innerText.slice(0, 400)), cards: [...document.querySelectorAll('.fc')].map(c => c.innerText) } }""")
    json.dump({'elapsed_s': elapsed, 'stages': stages, 'result': result, 'log': log}, open(f'{a.out}.json', 'w'), indent=1, ensure_ascii=False)
    ctx.close(); b.close()
    print(json.dumps({'elapsed_s': elapsed, 'stages': stages}, ensure_ascii=False, indent=1))
