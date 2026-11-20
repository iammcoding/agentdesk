import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as claude from '../src/adapters/claude.js';
import * as codex from '../src/adapters/codex.js';
import * as gemini from '../src/adapters/gemini.js';
import * as copilot from '../src/adapters/copilot.js';

const run = (parse, lines) => lines.flatMap(l => parse(l));
const kinds = evs => evs.map(e => e.t + (e.app ? ':' + e.app : ''));

test('claude: prompt, tools, results, usage, cost, plumbing skipped', () => {
  const parse = claude.createParser();
  const evs = run(parse, [
    { type: 'api-request-blob', message: { content: [{ type: 'text', text: 'ignored' }] } },
    { type: 'user', cwd: '/w/shop', gitBranch: 'main', message: { role: 'user', content: 'Add dark mode' } },
    { type: 'user', cwd: '/w/shop', gitBranch: 'main', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', cwd: '/w/shop', gitBranch: 'main', message: { usage: { input_tokens: 10, cache_read_input_tokens: 20000, output_tokens: 5 }, content: [
      { type: 'thinking', thinking: '' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/shop/a.ts' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git commit -m x', run_in_background: false } },
      { type: 'tool_use', id: 't3', name: 'mcp__github__create_pull_request', input: {} },
      { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: '/w/shop/shot.png' } },
    ] } },
    { type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '1\tconst a = 1' }] }, toolUseResult: { type: 'text', file: { filePath: '/w/shop/a.ts', content: 'const a = 1\nconst b = 2', startLine: 1, numLines: 2, totalLines: 2 } } },
    { type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'fatal', is_error: true }] }, toolUseResult: { stdout: '', stderr: 'fatal: nothing to commit', interrupted: false } },
    { type: 'user', cwd: '/w/shop', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: [{ type: 'image', source: { data: 'AAAA', media_type: 'image/png' } }] }] }, toolUseResult: { type: 'image', file: { base64: 'AAAA', type: 'image/png' } } },
    { type: 'cost-state', totalCostUSD: 0.42, modelUsage: { m: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10 } } },
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'system', subtype: 'api_error', content: 'overloaded' },
  ]);
  assert.deepEqual(kinds(evs), ['meta', 'prompt', 'usage', 'think', 'tool:ed', 'tool:term', 'tool:net', 'tool:img', 'result', 'result', 'result', 'cost', 'compact', 'retry']);
  const read = evs.find(e => e.t === 'result' && e.id === 't1');
  assert.deepEqual(read.lines, ['const a = 1', 'const b = 2']);
  const bash = evs.find(e => e.t === 'result' && e.id === 't2');
  assert.equal(bash.ok, false);
  assert.deepEqual(bash.lines, ['fatal: nothing to commit']);
  assert.equal(evs.find(e => e.app === 'term').git, true);
  assert.equal(evs.find(e => e.app === 'net').server, 'github');
  assert.equal(evs.find(e => e.t === 'result' && e.id === 't4').image, 'data:image/png;base64,AAAA');
  assert.equal(evs.find(e => e.t === 'cost').usd, 0.42);
  assert.equal(evs.find(e => e.t === 'usage').used, 20015);
});

test('claude: edit hunks, todos, task tools, background job, helper', () => {
  const parse = claude.createParser();
  const evs = run(parse, [
    { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'x', new_string: 'y' } },
      { type: 'tool_use', id: 'd1', name: 'TodoWrite', input: { todos: [{ content: 'One', status: 'completed' }, { content: 'Two', status: 'in_progress' }] } },
      { type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Ship it' } },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run dev', run_in_background: true } },
      { type: 'tool_use', id: 'h1', name: 'Agent', input: { description: 'Look around', subagent_type: 'Explore', prompt: 'find x' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] }, toolUseResult: { structuredPatch: [{ oldStart: 3, newStart: 3, lines: [' a', '-x', '+y'] }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #7 created' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '7', status: 'completed' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'Command running in background' }] }, toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'bg9' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'h1', content: [{ type: 'text', text: 'Found it' }] }] } },
  ]);
  const hunks = evs.find(e => e.t === 'result' && e.id === 'e1').hunks;
  assert.deepEqual(hunks, [{ start: 3, lines: [' a', '-x', '+y'] }]);
  const todos = evs.filter(e => e.t === 'todos');
  assert.deepEqual(todos[0].items, [{ text: 'One', status: 'completed' }, { text: 'Two', status: 'in_progress' }]);
  assert.deepEqual(todos.at(-1).items.at(-1), { text: 'Ship it', status: 'completed' });
  assert.equal(evs.find(e => e.t === 'result' && e.id === 'b1').job, 'bg9');
  assert.equal(evs.find(e => e.t === 'result' && e.id === 'h1').text, 'Found it');
  assert.equal(evs.find(e => e.app === 'help').kind, 'Explore');
});

test('codex: meta, prompt (context skipped), shell with exit code, apply_patch, plan, tokens', () => {
  const parse = codex.createParser();
  const evs = run(parse, [
    { type: 'session_meta', payload: { id: 'x', cwd: '/w/api', git: { branch: 'dev' }, history_mode: 'paginated' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the tests' }] } },
    { type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Looking at tests' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'c1' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 1\nOriginal token count: 5\nOutput:\nFAIL a.test.ts' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: 'Success. Updated the following files:\nM src/a.ts' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'update_plan', arguments: '{"plan":[{"step":"Fix","status":"in_progress"}]}', call_id: 'u1' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 9000, output_tokens: 300 }, total_token_usage: { total_tokens: 18845 }, model_context_window: 272000 } } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Fixed.' }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ]);
  assert.deepEqual(kinds(evs), ['meta', 'prompt', 'think', 'tool:term', 'result', 'tool:ed', 'result', 'todos', 'usage', 'cost', 'say', 'idle']);
  assert.equal(evs[0].project, 'api');
  const sh = evs.find(e => e.t === 'result' && e.id === 'c1');
  assert.equal(sh.ok, false);
  assert.deepEqual(sh.lines, ['FAIL a.test.ts']);
  const patch = evs.find(e => e.app === 'ed');
  assert.equal(patch.path, 'src/a.ts');
  assert.equal(patch.old, 'old');
  assert.equal(patch.new, 'new');
  assert.equal(evs.find(e => e.t === 'usage').max, 272000);
});

test('gemini: upserts by id show each thing once, tool results on status change', () => {
  const parse = gemini.createParser('/h/.gemini/tmp/shop/chats/session-2026-11-20T10-15-ab12cd34.jsonl');
  const tc = { id: 'run-1', name: 'run_shell_command', args: { command: 'ls' }, status: 'executing' };
  const evs = run(parse, [
    { sessionId: 'ab12', projectHash: 'shop', startTime: 't' },
    { id: 'u1', type: 'user', content: [{ text: 'List files' }] },
    { id: 'g1', type: 'gemini', content: [{ text: '' }], thoughts: [{ subject: 'Listing' }], toolCalls: [tc] },
    { id: 'g1', type: 'gemini', content: [{ text: '' }], thoughts: [{ subject: 'Listing' }], toolCalls: [{ ...tc, status: 'success', result: [{ functionResponse: { id: 'run-1', name: 'run_shell_command', response: { output: 'a.txt\nb.txt' } } }] }], tokens: { input: 800, output: 20, total: 820 } },
    { id: 'g1', type: 'gemini', content: [{ text: 'Two files.' }], thoughts: [{ subject: 'Listing' }], toolCalls: [{ ...tc, status: 'success' }], tokens: { input: 800, output: 25, total: 825 } },
    { $set: { lastUpdated: 'x' } },
  ]);
  assert.deepEqual(kinds(evs), ['meta', 'prompt', 'think', 'tool:term', 'result', 'usage', 'cost', 'say', 'usage', 'cost']);
  assert.equal(evs[0].project, 'shop');
  assert.deepEqual(evs.find(e => e.t === 'result').lines, ['a.txt', 'b.txt']);
  assert.equal(evs.at(-1).tokens, 825);
});

test('copilot: start, tool lifecycle', () => {
  const parse = copilot.createParser();
  const evs = run(parse, [
    { type: 'session.start', data: { context: { cwd: '/w/site' } } },
    { type: 'user.message', data: { content: 'Run lint' } },
    { type: 'tool.execution_start', data: { toolCallId: 'k1', toolName: 'bash', arguments: { command: 'npm run lint' } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'k1', success: true, result: { content: 'No problems' } } },
  ]);
  assert.deepEqual(kinds(evs), ['meta', 'prompt', 'tool:term', 'result']);
  assert.deepEqual(evs[3].lines, ['No problems']);
});

test('parsers never throw on junk', () => {
  for (const a of [claude, codex, gemini, copilot]) {
    const parse = a.createParser('/x');
    for (const junk of [null, 1, 'x', {}, { type: 'assistant' }, { type: 'response_item', payload: {} }, { id: 'a', type: 'gemini', toolCalls: [null, {}] }, { message: { content: 5 } }])
      assert.doesNotThrow(() => parse(junk));
  }
});
