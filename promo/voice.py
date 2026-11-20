#!/usr/bin/env python3
"""Makes the voice for promo/script.json with Cloudflare (Aura 2), and times every word with Whisper
so the captions land on the right word. Lines already made are kept in promo/work/, so changing one
line only pays for that line again.

Run it in your own terminal, with your Cloudflare details in the environment (never in a file):
    export CLOUDFLARE_ACCOUNT_ID=...   CLOUDFLARE_API_TOKEN=...
    python3 promo/voice.py
"""
import json, os, sys, hashlib, urllib.request, urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(HERE, 'work'); os.makedirs(WORK, exist_ok=True)
ACC = os.environ.get('CLOUDFLARE_ACCOUNT_ID', '')
TOKS = [t for t in os.environ.get('CLOUDFLARE_API_TOKEN', '').split(',') if t]
if not ACC or not TOKS: sys.exit('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in this terminal first.')

def cf(model, data, ct='application/json'):
    last = None
    for t in TOKS:
        r = urllib.request.Request(f'https://api.cloudflare.com/client/v4/accounts/{ACC}/ai/run/{model}', data=data,
                                   headers={'Authorization': 'Bearer ' + t, 'Content-Type': ct})
        try: return urllib.request.urlopen(r, timeout=180).read()
        except urllib.error.HTTPError as e: last = f'{e.code} {e.read()[:200]}'
    sys.exit(f'Cloudflare {model} failed: {last}')

S = json.load(open(os.path.join(HERE, 'script.json')))
voice = S.get('voice', 'thalia')
TIMING = os.path.join(WORK, 'timing.json')
timing = json.load(open(TIMING)) if os.path.exists(TIMING) else {}
for i, ln in enumerate(S['lines']):
    key = hashlib.sha1((voice + ln['say']).encode()).hexdigest()[:10]
    mp3 = os.path.join(WORK, f'v_{key}.mp3')
    if not os.path.exists(mp3):
        a = cf('@cf/deepgram/aura-2-en', json.dumps({'text': ln['say'], 'speaker': voice}).encode())
        if a[:1] == b'{': sys.exit('voice failed: ' + a[:200].decode(errors='ignore'))
        open(mp3, 'wb').write(a); print('voice', i + 1, 'of', len(S['lines']))
    if key not in timing:
        w = json.loads(cf('@cf/openai/whisper', open(mp3, 'rb').read(), 'application/octet-stream'))['result']
        timing[key] = [(x['start'], x['end']) for x in w.get('words', [])]
        json.dump(timing, open(TIMING, 'w'))
print('Voice ready. Tell Claude, and it will finish the video.')
