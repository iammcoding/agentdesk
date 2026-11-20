// Records the AgentDesk sample session as real footage, at 2x resolution so zoom-ins stay sharp.
// node promo/record.mjs  ->  promo/work/desk.mp4 + promo/work/marks.json (when each step started)
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work'); const FR = path.join(WORK, 'desk-frames');
fs.rmSync(FR, { recursive: true, force: true }); fs.mkdirSync(FR, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Recorded in slow motion (everything at SLOW speed), then played back at normal speed: smoother and sharper.
const SLOW = 0.3;

const server = spawn('node', [path.join(HERE, '..', 'bin', 'agentdesk.js'), '--no-open', '--port', '4795'], { stdio: 'ignore' });
await sleep(1200);
const prof = path.join(WORK, 'chrome-prof');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--remote-debugging-port=9340', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
let list; for (let i = 0; i < 60; i++) { try { list = await (await fetch('http://127.0.0.1:9340/json/list')).json(); if (list.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const frames = [];
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Page.screencastFrame') {
    const n = frames.length; fs.writeFileSync(path.join(FR, `${String(n).padStart(5, '0')}.jpg`), Buffer.from(d.params.data, 'base64'));
    frames.push(d.params.metadata.timestamp); send('Page.screencastFrameAck', { sessionId: d.params.sessionId });
  }
};
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: 'http://localhost:4795/?demo' });
await sleep(2500);
// Take over from the built-in sample loop so every step can be timed; show the desk as LIVE.
await send('Animation.enable');
await send('Animation.setPlaybackRate', { playbackRate: SLOW });
await send('Runtime.evaluate', { expression: `speed=${SLOW};demo.on=false;demo.run++;Q.length=0;conn.ok=true;conn.file='session';enqueue({t:'reset',agent:'Claude Code'});render(true);` });
await sleep(600);
// Full-resolution screenshots in a loop (screencast frames ignore the 2x scale).
let shooting = true;
const shooter = (async () => { while (shooting) { const t0 = Date.now() / 1000; const s = await send('Page.captureScreenshot', { format: 'jpeg', quality: 90, optimizeForSpeed: true }); const t1 = Date.now() / 1000; fs.writeFileSync(path.join(FR, `${String(frames.length).padStart(5, '0')}.jpg`), Buffer.from(s.result.data, 'base64')); frames.push((t0 + t1) / 2); } })();
await sleep(800);
const r = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `(async()=>{
  const marks=[];const t0=performance.now();
  const idle=()=>new Promise(r=>{const t=setInterval(()=>{if(!Q.length&&!pumping){clearInterval(t);r();}},20);});
  for(let i=0;i<DEMO.length;i++){const ev=DEMO[i];
    if(ev.t==='pause'){await new Promise(r=>setTimeout(r,ev.ms/${SLOW}));continue;}
    if(ev.t==='reset')continue;
    marks.push({i,t:ev.t,id:ev.id||null,app:ev.app||null,view:ev.view?ev.view.kind:null,ok:ev.ok,at:(performance.now()-t0)/1000*${SLOW}});
    enqueue({...ev});await idle();await new Promise(r=>setTimeout(r,120/${SLOW}));
    document.getElementById('live').className='live on';document.getElementById('live').textContent='LIVE';
  }
  await new Promise(r=>setTimeout(r,2500/${SLOW}));
  return {marks,wall:Date.now()/1000,perf:(performance.now()-t0)/1000};
})()` });
shooting = false; await shooter;
const res = r.result.result.value;
// screencast timestamps are wall-clock seconds; the page's t0 = wall - perf
const t0wall = res.wall - res.perf;
const first = frames[0];
fs.writeFileSync(path.join(WORK, 'marks.json'), JSON.stringify({ offset: (t0wall - first) * SLOW, marks: res.marks }, null, 1));
// constant 30 fps video from the variable-rate frames
let list2 = '';
for (let i = 0; i < frames.length; i++) {
  const d = (i + 1 < frames.length ? frames[i + 1] - frames[i] : 1 / 30 / SLOW) * SLOW;
  list2 += `file '${path.join(FR, String(i).padStart(5, '0') + '.jpg')}'\nduration ${Math.max(0.001, d).toFixed(4)}\n`;
}
fs.writeFileSync(path.join(WORK, 'frames.txt'), list2);
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(WORK, 'frames.txt'), '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '14', '-preset', 'medium', path.join(WORK, 'desk.mp4')]);
const span = frames[frames.length - 1] - first;
console.log(`frames ${frames.length} over ${(span*SLOW).toFixed(1)}s of footage = ${(frames.length / span / SLOW).toFixed(1)} fps; desk.mp4 written; ${res.marks.length} marks`);
ws.close(); chrome.kill(); server.kill(); process.exit(0);
