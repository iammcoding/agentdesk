// Builds promo/out/agentdesk-promo.mp4 (1080x1350, 30 fps) from:
//   promo/script.json   what the voice says and which shot goes with each line
//   promo/work/         desk footage (record.mjs) and the voice (voice.py)
// node promo/build.mjs [--preview]   (--preview: no voice needed, timings estimated, first pass)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work'), OUT = path.join(HERE, 'out');
fs.mkdirSync(OUT, { recursive: true });
const FPS = 30;
const S = JSON.parse(fs.readFileSync(path.join(HERE, 'script.json'), 'utf8'));
const voice = S.voice || 'thalia', SPEED = S.speed || 1.08, GAP = S.gap ?? 0.18, TAIL = 2.6, LEAD = 0.3;
const timingFile = path.join(WORK, 'timing.json');
const timing = fs.existsSync(timingFile) ? JSON.parse(fs.readFileSync(timingFile, 'utf8')) : {};
const dur = f => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString());
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const only = process.argv.includes('--preview');

/* ---------- 1. plan: when each line and word happens ---------- */
let t = LEAD, missing = 0;
const lines = S.lines.map(ln => {
  const key = crypto.createHash('sha1').update(voice + ln.say).digest('hex').slice(0, 10);
  const mp3 = path.join(WORK, `v_${key}.mp3`);
  const words = (ln.show || ln.say).split(/\s+/).filter(Boolean);
  let vd, tm;
  if (fs.existsSync(mp3) && timing[key]) {
    vd = dur(mp3) / SPEED;
    const wt = timing[key];
    if (wt.length === words.length) tm = wt.map(([a, b]) => [a / SPEED, b / SPEED]);
    else { // spread by length when the counts differ
      const s0 = (wt[0]?.[0] ?? 0.05) / SPEED, s1 = (wt.at(-1)?.[1] ?? vd * SPEED) / SPEED;
      const tot = words.reduce((a, w) => a + w.length + 1, 0); let c = 0;
      tm = words.map(w => { const d = (w.length + 1) / tot * (s1 - s0); const r = [s0 + c, s0 + c + d]; c += d; return r; });
    }
  } else {
    missing++; // estimate: about 2.9 words a second
    const per = 0.34; vd = words.length * per + 0.25;
    tm = words.map((w, i) => [0.1 + i * per, 0.1 + i * per + per * 0.9]);
  }
  const L = { shot: ln.shot, say: ln.say, mp3: fs.existsSync(mp3) ? mp3 : null, start: t, voiceAt: t,
    words: words.map((w, i) => ({ w, t0: t + tm[i][0], t1: t + tm[i][1] })), punch: ln.punch || [] };
  t += vd + GAP; L.end = t; return L;
});
if (missing && !only) { console.error(`${missing} voice lines are missing. Run python3 promo/voice.py first, or use --preview.`); process.exit(1); }
lines[0].start = 0; lines.at(-1).end = t + TAIL;
const total = lines.at(-1).end;
const plan = { fps: FPS, total, lines };
fs.writeFileSync(path.join(WORK, 'plan.json'), JSON.stringify(plan, null, 1));
// footage time of every recorded desk frame
const ft = []; let acc = 0;
for (const l of fs.readFileSync(path.join(WORK, 'frames.txt'), 'utf8').split('\n')) { const m = /^duration ([\d.]+)/.exec(l); if (m) { ft.push(acc); acc += parseFloat(m[1]); } }
console.log(`${lines.length} lines, ${total.toFixed(1)} s${missing ? ` (${missing} timings estimated)` : ''}`);

/* ---------- 2. sound ---------- */
const get = (url, f) => { if (!fs.existsSync(f)) sh('curl', ['-s', '-L', '-A', 'Mozilla/5.0', '-o', f, url]); return f; };
const music = get(`https://assets.mixkit.co/music/${S.music || 131}/${S.music || 131}.mp3`, path.join(WORK, `music_${S.music || 131}.mp3`));
const woosh = get('https://assets.mixkit.co/active_storage/sfx/1490/1490-preview.mp3', path.join(WORK, 'woosh.mp3'));
const pop = get('https://assets.mixkit.co/active_storage/sfx/3005/3005-preview.mp3', path.join(WORK, 'pop.mp3'));
// made here: a deep hit for slams, a short glitch burst, and a key click for typing
const synth = (name, filter) => { const f = path.join(WORK, name); if (!fs.existsSync(f)) sh('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', filter, '-ar', '48000', '-ac', '2', f]); return f; };
const boom = synth('boom.wav', "aevalsrc='0.9*sin(2*PI*(42+90*exp(-18*t))*t)*exp(-5.5*t)+0.25*(random(0)-0.5)*exp(-40*t)':s=48000:d=0.9");
const glitch = synth('glitch.wav', "aevalsrc='0.5*(random(0)*2-1)*(lt(mod(t,0.07),0.035))*exp(-3*t)+0.3*sin(2*PI*1400*t)*lt(mod(t,0.11),0.02)':s=48000:d=0.55");
const click = synth('click.wav', "aevalsrc='0.6*(random(0)*2-1)*exp(-260*t)':s=48000:d=0.05");
const hits = [];
lines.forEach((L, i) => {
  const prev = lines[i - 1];
  if (i && L.shot !== prev.shot) hits.push([woosh, L.start - 0.1, 0.28]);
  if (L.shot === 'terminal-glitch') hits.push([glitch, L.start, 0.7]);
  if (L.shot === 'logo') hits.push([boom, L.start + 0.05, 0.9]);
  if (L.shot === 'zoom-tests') { const w = L.words.find(w => /^fail/i.test(w.w)); if (w) hits.push([boom, w.t0, 0.6], [glitch, w.t0, 0.35]); }
  if (L.shot === 'tokens') { const w = L.words.find(w => w.w === '0'); if (w) hits.push([boom, w.t0, 0.75]); }
  if (L.shot === 'agents') L.words.filter(w => /^(Claude|Codex|Gemini)/i.test(w.w)).forEach(w => hits.push([pop, w.t0, 0.5]));
  if (L.shot === 'command') {
    L.words.filter(w => /^(Free|Open|One)/i.test(w.w)).forEach(w => hits.push([pop, w.t0, 0.45]));
    const t1 = (L.words.find(w => /^One/i.test(w.w))?.t0 ?? L.start + 1) - L.start + 0.35, n = 'npx @iammcoding/agentdesk'.length;
    for (let k = 0; k < n; k++) hits.push([click, L.start + t1 * k / n, 0.22]);
  }
  if (L.shot === 'end') hits.push([pop, L.start + 0.5, 0.5], [pop, L.start + 0.65, 0.5]);
  if (L.punch.length) L.words.filter(w => L.punch.includes(w.w)).forEach(w => hits.push([pop, w.t0, 0.25]));
});
const audio = path.join(WORK, 'mix.m4a');
{
  const inp = ['-ss', String(S.musicStart ?? 0), '-t', String(total), '-i', music]; const f = []; const vs = []; const fx = [];
  const voiced = lines.filter(L => L.mp3);
  voiced.forEach((L, n) => { inp.push('-i', L.mp3); const d = Math.round(L.voiceAt * 1000); f.push(`[${n + 1}:a]atempo=${SPEED},aresample=48000,aformat=channel_layouts=stereo,adelay=${d}|${d}[v${n}]`); vs.push(`[v${n}]`); });
  hits.forEach(([src, at, vol], j) => { inp.push('-i', src); const k = voiced.length + 1 + j, d = Math.max(0, Math.round(at * 1000)); f.push(`[${k}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${vol},adelay=${d}|${d}[x${j}]`); fx.push(`[x${j}]`); });
  const mv = S.musicVolume ?? 0.32;
  f.push(`[0:a]aresample=48000,aformat=channel_layouts=stereo,volume=${mv},afade=t=in:d=0.4,afade=t=out:st=${(total - 2).toFixed(2)}:d=2[m]`);
  if (vs.length) {
    f.push(`${vs.join('')}amix=inputs=${vs.length}:normalize=0,apad=whole_dur=${total.toFixed(2)},asplit=2[vm][vk]`);
    f.push('[m][vk]sidechaincompress=threshold=0.015:ratio=10:attack=10:release=350[md]');
    f.push(`[vm][md]${fx.join('')}amix=inputs=${2 + fx.length}:normalize=0,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11[o]`);
  } else f.push(`[m]${fx.join('')}amix=inputs=${1 + fx.length}:normalize=0,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.5:LRA=11[o]`);
  sh('ffmpeg', ['-y', '-v', 'error', ...inp, '-filter_complex', f.join(';'), '-map', '[o]', '-ar', '48000', '-c:a', 'aac', '-b:a', '192k', audio]);
}
console.log(`sound mixed (${hits.length} effects)`);

/* ---------- 3. pictures: draw every frame in Chrome and pipe it to the encoder ---------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--remote-debugging-port=9342', '--user-data-dir=' + path.join(WORK, 'chrome-compose'), 'about:blank'], { stdio: 'ignore' });
let tabs; for (let i = 0; i < 60; i++) { try { tabs = await (await fetch('http://127.0.0.1:9342/json/list')).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const errs = [];
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1350, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'file://' + path.join(HERE, 'compose.html') });
await sleep(2500);
const ok = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `setup(${JSON.stringify(plan)},${JSON.stringify(ft)})` });
if (!ok.result?.result?.value) { console.error('setup failed', JSON.stringify(ok).slice(0, 400), errs); process.exit(1); }

const out = path.join(OUT, only ? 'agentdesk-promo-preview.mp4' : 'agentdesk-promo.mp4');
const enc = spawn('ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-i', audio,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart',
  '-c:a', 'copy', '-t', total.toFixed(2), out], { stdio: ['pipe', 'inherit', 'inherit'] });
const N = Math.ceil(total * FPS); const t0 = Date.now();
for (let f = 0; f < N; f++) {
  const r = await send('Runtime.evaluate', { awaitPromise: true, expression: `renderAt(${(f / FPS).toFixed(4)})` });
  if (r.result?.exceptionDetails) { console.error('frame', f, r.result.exceptionDetails.exception?.description); process.exit(1); }
  const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 94, optimizeForSpeed: true });
  if (!enc.stdin.write(Buffer.from(s.result.data, 'base64'))) await new Promise(r => enc.stdin.once('drain', r));
  if (f % 150 === 0) console.log(`frame ${f}/${N}  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
enc.stdin.end(); await new Promise(r => enc.on('close', r));
ws.close(); chrome.kill();
if (errs.length) console.log('page errors:', [...new Set(errs)].slice(0, 5));
console.log('done', out);
process.exit(0);
