import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import * as claude from '../src/adapters/claude.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-rt-'));
const proj = path.join(tmp, 'projects', '-w-shop');
const file = path.join(proj, 'sess-1.jsonl');
let hub;
const got = [];

const line = (f, o) => fs.appendFileSync(f, JSON.stringify(o) + '\n');
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout; got ' + JSON.stringify(got.map(e => e.t + (e.id ? ':' + e.id : '')))); };
const hook = h => hub.hook({ transcript_path: file, session_id: 'sess-1', ...h });

before(async () => {
  process.env.CLAUDE_CONFIG_DIR = tmp;
  fs.mkdirSync(proj, { recursive: true });
  line(file, { type: 'user', cwd: '/w/shop', message: { role: 'user', content: 'Start' } });
  hub = new Hub([claude]).start();
  hub.addClient(ev => got.push(ev));
  await until(() => got.some(e => e.t === 'live'));
});

after(() => { hub.stop(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('a new log line reaches the desk quickly and carries its time', async () => {
  const t0 = Date.now();
  line(file, { type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'text', text: 'Quick one' }] } });
  const ev = await until(() => got.find(e => e.t === 'say' && e.text === 'Quick one'));
  const took = Date.now() - t0;
  assert.ok(took < 450, `took ${took} ms`);
  assert.ok(Math.abs(ev.at - Date.now()) < 1000, 'live events are stamped with the time the server saw them');
  assert.ok(!ev.replay);
});

test('PreToolUse hook shows the tool at once; the log line for the same call is not shown twice', async () => {
  hook({ hook_event_name: 'PreToolUse', tool_use_id: 'T1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  const first = got.filter(e => e.t === 'tool' && e.id === 'T1');
  assert.equal(first.length, 1, 'shown straight from the hook, before any log line exists');
  assert.equal(first[0].app, 'term');
  line(file, { type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'tool_use', id: 'T1', name: 'Bash', input: { command: 'npm test' } }] } });
  line(file, { type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: 'T1', content: 'ok' }] }, toolUseResult: { stdout: 'PASS', stderr: '' } });
  const res = await until(() => got.find(e => e.t === 'result' && e.id === 'T1'));
  assert.deepEqual(res.lines, ['PASS']);
  assert.equal(got.filter(e => e.t === 'tool' && e.id === 'T1').length, 1);
});

test('Stop hook delivers the final message even before the log has it, once', async () => {
  hook({ hook_event_name: 'Stop', last_assistant_message: 'All done.' });
  assert.equal(got.filter(e => e.t === 'say' && e.text === 'All done.').length, 1);
  assert.ok(got.some(e => e.t === 'idle'));
  line(file, { type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'text', text: 'All done.' }] } });
  line(file, { type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'text', text: 'After' }] } });
  await until(() => got.find(e => e.t === 'say' && e.text === 'After'));
  assert.equal(got.filter(e => e.t === 'say' && e.text === 'All done.').length, 1);
});

test('permission: the early hook wins, the late notification does not overwrite it', () => {
  const n = got.length;
  hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  const perms = got.slice(n).filter(e => e.t === 'permission');
  assert.equal(perms.length, 1);
  assert.equal(perms[0].detail, 'rm -rf build');
});

test('StopFailure shows the error', () => {
  const n = got.length;
  hook({ hook_event_name: 'StopFailure', error: 'rate_limit', last_assistant_message: 'API Error: Rate limit reached' });
  assert.equal(got.slice(n).find(e => e.t === 'retry').text, 'API Error: Rate limit reached');
});

test('hooks from another session or from inside a helper do not disturb the desk', () => {
  const n = got.length;
  hub.hook({ transcript_path: path.join(proj, 'other.jsonl'), hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  // a hook fired inside a helper (that helper has its own log) is covered by the helper's log
  const dir = path.join(proj, 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  line(path.join(dir, 'agent-abc.jsonl'), { type: 'user', isSidechain: true, message: { role: 'user', content: 'go' } });
  hook({ hook_event_name: 'PreToolUse', agent_id: 'abc', tool_use_id: 'H9', tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.equal(got.slice(n).filter(e => e.t === 'permission' || e.t === 'tool').length, 0);
  // but a whole session started with --agent also carries agent_id: its hooks must still count
  hook({ hook_event_name: 'PreToolUse', agent_id: 'reviewer', agent_type: 'reviewer', tool_use_id: 'M1', tool_name: 'Read', tool_input: { file_path: '/w/shop/a.ts' } });
  assert.equal(got.slice(n).filter(e => e.t === 'tool' && e.id === 'M1').length, 1);
  // a hook cannot point the desk at a file outside the agents' log folders
  const before = hub.cur.file;
  hub.hook({ hook_event_name: 'SessionStart', transcript_path: '/etc/hosts' });
  hub.hook({ hook_event_name: 'UserPromptSubmit', transcript_path: path.join(tmp, 'elsewhere.jsonl') });
  assert.equal(hub.cur.file, before);
  for (const junk of [null, 5, 'x', {}, { hook_event_name: 'Nope' }, { hook_event_name: 'PreToolUse' }]) assert.doesNotThrow(() => hub.hook(junk));
});

test('shell commands carry their window, the reading of their output, and real diffs', async () => {
  const use = (id, command) => line(file, { type: 'assistant', cwd: '/w/shop', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, stdout, extra = {}, bad = false) => line(file, { type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: id, content: stdout, is_error: bad }] }, toolUseResult: { stdout, stderr: '', ...extra } });
  use('V1', 'npm test -- settings 2>&1 | tail -20');
  res('V1', ' FAIL  src/a.test.ts\n  ✕ renders the toggle\nTests:  1 failed, 4 passed, 5 total', {}, true);
  use('V2', "sed -n '3,4p' src/theme.ts");
  res('V2', 'line three\nline four');
  use('V3', "sed -i '' 's/a/b/' src/theme.ts");
  res('V3', '', { bashEditDiff: { files: [{ filePath: '/w/shop/src/theme.ts', hunks: [{ oldStart: 3, newStart: 3, lines: [' x', '-a', '+b'] }] }] } });
  use('V4', 'cat a.ts | grep foo > out.txt');
  res('V4', '');
  await until(() => got.find(e => e.t === 'result' && e.id === 'V4'));
  const tool = id => got.find(e => e.t === 'tool' && e.id === id), result = id => got.find(e => e.t === 'result' && e.id === id);
  assert.equal(tool('V1').win, 'test');
  assert.deepEqual([result('V1').out.passed, result('V1').out.failed, result('V1').ok], [4, 1, false]);
  assert.deepEqual(tool('V2').view, { kind: 'read', path: 'src/theme.ts', start: 3, end: 4 });
  assert.deepEqual(result('V2').lines, ['line three', 'line four']);
  assert.equal(tool('V3').view.kind, 'edit');
  assert.deepEqual(result('V3').edits, [{ path: '/w/shop/src/theme.ts', created: false, deleted: false, hunks: [{ start: 3, lines: [' x', '-a', '+b'] }] }]);
  assert.equal(tool('V4').view, undefined, 'a pipeline that writes a file stays in the Shell');
});

test('a helper agent\'s own log is followed and reported as steps under the call that started it', async () => {
  const dir = path.join(proj, 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const hf = path.join(dir, 'agent-a1.jsonl');
  fs.writeFileSync(hf.replace('.jsonl', '.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Find theme', toolUseId: 'CALL1' }));
  line(hf, { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'find it' } });
  line(hf, { type: 'assistant', isSidechain: true, agentId: 'a1', message: { content: [{ type: 'tool_use', id: 'h1', name: 'Read', input: { file_path: '/w/shop/src/theme.ts' } }] } });
  const step = await until(() => got.find(e => e.t === 'helper' && e.text === 'Read theme.ts'), 4000);
  assert.equal(step.id, 'CALL1');
  assert.equal(step.kind, 'Explore');
  line(hf, { type: 'assistant', isSidechain: true, agentId: 'a1', message: { content: [{ type: 'tool_use', id: 'h2', name: 'Grep', input: { pattern: 'useTheme' } }] } });
  await until(() => got.find(e => e.t === 'helper' && e.text === 'Search useTheme'));
  assert.ok(!got.some(e => e.t === 'tool' && (e.id === 'h1' || e.id === 'h2')), 'helper tools never open the main agent\'s windows');
});
