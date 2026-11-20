import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Hub } from '../src/hub.js';
import { createServer, listen } from '../src/server.js';
import * as claude from '../src/adapters/claude.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-'));
const proj = path.join(tmp, 'projects', '-w-shop');
const file = path.join(proj, 'sess-1.jsonl');
let server, hub, port;

const line = o => fs.appendFileSync(file, JSON.stringify(o) + '\n');

before(async () => {
  process.env.CLAUDE_CONFIG_DIR = tmp;
  fs.mkdirSync(proj, { recursive: true });
  line({ type: 'user', cwd: '/w/shop', gitBranch: 'main', message: { role: 'user', content: 'Earlier prompt' } });
  hub = new Hub([claude]).start();
  server = createServer(hub);
  port = await listen(server, 0);
});

after(() => { hub.stop(); server.close(); server.closeAllConnections?.(); fs.rmSync(tmp, { recursive: true, force: true }); });

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function post(p, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify(data));
  });
}

/* Opens the live stream and collects events until `until` returns true. */
function stream(until, ms = 5000) {
  return new Promise((resolve, reject) => {
    const evs = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/events' }, res => {
      let buf = '';
      res.on('data', c => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(chunk);
          if (m) { evs.push(JSON.parse(m[1])); if (until(evs)) { req.destroy(); resolve(evs); } }
        }
      });
    });
    req.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
    setTimeout(() => { req.destroy(); reject(new Error('timeout; got ' + JSON.stringify(evs.map(e => e.t)))); }, ms);
  });
}

test('serves the desk page and fonts', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /<title>AgentDesk<\/title>/);
  assert.equal((await get('/fonts/silkscreen-400.woff2')).status, 200);
  assert.equal((await get('/fonts/../package.json')).status, 404);
});

test('refuses other hosts and other sites', async () => {
  assert.equal((await get('/', { host: 'evil.example' })).status, 403);
  assert.equal((await get('/sessions', { origin: 'https://evil.example' })).status, 403);
});

test('a new desk gets the backfill, then live events as the log grows', async () => {
  const p = stream(evs => evs.some(e => e.t === 'result' && e.id === 'L1'));
  await new Promise(r => setTimeout(r, 300));
  line({ type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'tool_use', id: 'L1', name: 'Bash', input: { command: 'npm test' } }] } });
  line({ type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: 'L1', content: 'ok' }] }, toolUseResult: { stdout: 'PASS', stderr: '' } });
  const evs = await p;
  assert.equal(evs[0].t, 'reset');
  const backfilled = evs.find(e => e.t === 'prompt');
  assert.equal(backfilled.text, 'Earlier prompt');
  assert.equal(backfilled.replay, true);
  const live = evs.find(e => e.t === 'tool' && e.id === 'L1');
  assert.ok(!live.replay, 'live events are not marked as replay');
  assert.deepEqual(evs.find(e => e.t === 'result').lines, ['PASS']);
});

test('hooks: permission prompt and finished turn reach the desk', async () => {
  const p = stream(evs => evs.some(e => e.t === 'idle'));
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await post('/hook', { hook_event_name: 'PermissionRequest', transcript_path: file, tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }), 204);
  await post('/hook', { hook_event_name: 'Stop', transcript_path: file });
  const evs = await p;
  const perm = evs.find(e => e.t === 'permission');
  assert.equal(perm.tool, 'Bash');
  assert.equal(perm.detail, 'rm -rf build');
});

test('session list and pinning only accept known sessions', async () => {
  const r = JSON.parse((await get('/sessions')).body);
  assert.equal(r.sessions[0].file, file);
  assert.equal(r.sessions[0].project, 'shop');
  assert.equal(await post('/watch', { file: '/etc/passwd' }), 404);
  assert.equal(await post('/watch', { file }), 200);
  assert.equal(hub.mode, 'pinned');
  assert.equal(await post('/watch', { file: 'auto' }), 200);
  assert.equal(hub.mode, 'auto');
});

test('stays on a session that is still working, moves to a newer one once it goes quiet', async () => {
  const other = path.join(proj, 'sess-2.jsonl');
  line({ type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'text', text: 'still busy' }] } });
  fs.writeFileSync(other, JSON.stringify({ type: 'user', cwd: '/w/two', message: { role: 'user', content: 'New one' } }) + '\n');
  const future = new Date(Date.now() + 10000);
  fs.utimesSync(other, future, future);
  await new Promise(r => setTimeout(r, 2000));
  assert.equal(hub.cur.file, file, 'two busy sessions must not make the desk flip back and forth');

  const p = stream(evs => evs.some(e => e.t === 'reset' && e.file === other), 6000);
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past); // the watched session went quiet a minute ago
  const evs = await p;
  assert.ok(evs.some(e => e.t === 'reset' && e.file === other));
});

test('typing a prompt in another session moves the desk there at once', async () => {
  assert.equal(await post('/hook', { hook_event_name: 'UserPromptSubmit', transcript_path: file, prompt: 'back here' }), 204);
  assert.equal(hub.cur.file, file);
});
