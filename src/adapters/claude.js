/*
 * Claude Code writes one JSON object per line to ~/.claude/projects/<folder>/<session>.jsonl
 * (or $CLAUDE_CONFIG_DIR/projects). Only `user`, `assistant`, `system`, `cost-state` and
 * `ai-title` lines matter here; the many others (api-request-*, attachment, …) are skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cut, textOf, IMAGE_EXT, lastSeg, isGit, isGh, isBrowserTool, tailLines, outLines } from '../events.js';

export const id = 'claude';
export const label = 'Claude Code';
export const format = 'jsonl';

export function roots() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return [path.join(base, 'projects')];
}

/* Session files are <root>/<project folder>/<uuid>.jsonl (helpers live deeper, in subagents/). */
export const depth = 2;
export const match = f => f.endsWith('.jsonl');

/* Lines that are Claude Code's own plumbing, not something you typed. */
const PLUMBING = /^\s*<(command-|local-command|system-reminder|bash-|user-memory|task-notification|ide_|artifact|pasted)/;
const isPlumbing = t => !t.trim() || PLUMBING.test(t) || /^Caveat: The messages below/.test(t) || t.startsWith('[Request interrupted');

export function mapTool(name, input = {}) {
  const base = { name };
  switch (name) {
    case 'Read':
      if (IMAGE_EXT.test(input.file_path || '')) return { ...base, app: 'img', path: input.file_path };
      return { ...base, app: 'ed', op: 'read', path: input.file_path };
    case 'Write':
      return { ...base, app: 'ed', op: 'write', path: input.file_path, content: cut(input.content, 20000) };
    case 'Edit':
      return { ...base, app: 'ed', op: 'edit', path: input.file_path, old: cut(input.old_string, 6000), new: cut(input.new_string, 6000) };
    case 'MultiEdit':
      return { ...base, app: 'ed', op: 'edit', path: input.file_path, old: cut((input.edits || []).map(e => e.old_string).join('\n'), 6000), new: cut((input.edits || []).map(e => e.new_string).join('\n'), 6000) };
    case 'NotebookEdit':
      return { ...base, app: 'ed', op: 'edit', path: input.notebook_path, old: '', new: cut(input.new_source, 6000) };
    case 'Bash':
      return { ...base, app: 'term', command: cut(input.command, 2000), desc: cut(input.description, 200), background: !!input.run_in_background, git: isGit(input.command), gh: isGh(input.command) };
    case 'Glob':
      return { ...base, app: 'files', pattern: input.pattern, path: input.path };
    case 'Grep':
      return { ...base, app: 'files', pattern: input.pattern, path: input.path, grep: true };
    case 'LS':
      return { ...base, app: 'files', pattern: '*', path: input.path };
    case 'WebFetch':
      return { ...base, app: 'web', url: input.url };
    case 'WebSearch':
      return { ...base, app: 'web', query: input.query };
    case 'Task':
    case 'Agent':
      return { ...base, app: 'help', desc: cut(input.description, 200), kind: input.subagent_type || 'helper', prompt: cut(input.prompt, 1500) };
    case 'AskUserQuestion': {
      const q = (input.questions || [])[0] || {};
      return { ...base, app: 'ask', question: cut(q.question, 400), header: q.header, options: (q.options || []).slice(0, 5).map(o => ({ label: cut(o.label, 80), description: cut(o.description, 160) })) };
    }
    case 'KillShell':
    case 'KillBash':
    case 'TaskStop':
      return { ...base, app: 'other', job: input.shell_id || input.task_id || input.bash_id };
  }
  if (name.startsWith('mcp__')) {
    const [, server = 'mcp', ...rest] = name.split('__');
    const tool = rest.join('__');
    if (isBrowserTool(server) || isBrowserTool(tool)) return { ...base, app: 'web', url: input.url || '', action: tool, server };
    return { ...base, app: 'net', server, tool };
  }
  return { ...base, app: 'other' };
}

/* What the desk shows when a tool finishes. */
function resultFor(tool, block, tur) {
  const ok = !block.is_error;
  const text = textOf(block.content);
  const r = { ok };
  const T = tur && typeof tur === 'object' && !Array.isArray(tur) ? tur : null;
  const imgBlock = Array.isArray(block.content) && block.content.find(b => b && b.type === 'image' && b.source && b.source.data);
  if (T && T.type === 'image' && T.file && T.file.base64) r.image = `data:${T.file.type || 'image/png'};base64,${T.file.base64}`;
  else if (imgBlock) r.image = `data:${imgBlock.source.media_type || 'image/png'};base64,${imgBlock.source.data}`;

  const name = tool ? tool.name : '';
  if (name === 'Read' && T && T.file && typeof T.file.content === 'string') {
    r.start = T.file.startLine || 1;
    r.lines = T.file.content.split('\n').slice(0, 400).map(l => cut(l, 300));
    r.total = T.file.totalLines;
    return r;
  }
  if ((name === 'Edit' || name === 'MultiEdit' || name === 'Write') && T && Array.isArray(T.structuredPatch)) {
    r.hunks = T.structuredPatch.slice(0, 8).map(h => ({ start: h.newStart, lines: (h.lines || []).slice(0, 120).map(l => cut(l, 300)) }));
    if (!ok) r.text = cut(text, 600);
    return r;
  }
  if (name === 'Bash' && T && ('stdout' in T || 'stderr' in T)) {
    const out = [T.stdout, T.stderr].filter(Boolean).join('\n');
    r.lines = outLines(out || (T.backgroundTaskId ? '' : text)).map(l => cut(l, 300));
    if (T.backgroundTaskId) r.job = T.backgroundTaskId;
    // Claude Code records what a shell command changed on disk: show those as real edits.
    const d = T.bashEditDiff;
    if (d && Array.isArray(d.files) && d.files.length) {
      r.edits = d.files.slice(0, 4).map(f => ({ path: f.filePath, created: !!f.created, deleted: !!f.deleted,
        hunks: (f.hunks || []).slice(0, 6).map(h => ({ start: h.newStart || h.oldStart || 1, lines: (h.lines || []).slice(0, 80).map(l => cut(l, 300)) })) }));
      r.moreEdits = Math.max(0, d.files.length - 4) + (d.moreFiles || 0);
    } else if (d && Array.isArray(d.changedFiles) && d.changedFiles.length) {
      r.edits = d.changedFiles.slice(0, 4).map(p => ({ path: p, hunks: [] }));
      r.moreEdits = Math.max(0, d.changedFiles.length - 4) + (d.moreFiles || 0);
    }
    if (T.interrupted) r.ok = false;
    return r;
  }
  if ((name === 'Glob' || name === 'Grep') && T && Array.isArray(T.filenames)) {
    r.files = T.filenames.slice(0, 40);
    r.count = T.numFiles ?? T.filenames.length;
    return r;
  }
  if (name === 'AskUserQuestion' && T && T.answers) {
    r.answer = cut(Object.values(T.answers).join(', '), 200);
    return r;
  }
  if (name === 'WebSearch' && T && Array.isArray(T.results)) {
    const hits = T.results.flatMap(x => (x && Array.isArray(x.content) ? x.content : [])).slice(0, 6);
    if (hits.length) r.links = hits.map(h => ({ title: cut(h.title, 120), url: h.url }));
  }
  r.text = cut(text, 1500);
  return r;
}

/* A helper agent's log sits beside the session: <session>/subagents/agent-<id>.jsonl, with a
   .meta.json that names the tool call that started it. Same line format, marked isSidechain. */
export function helperFiles(sessionFile) {
  const dir = path.join(sessionFile.replace(/\.jsonl$/, ''), 'subagents');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!/^agent-.*\.jsonl$/.test(n)) continue;
    const file = path.join(dir, n);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
    let mtime = 0;
    try { mtime = fs.statSync(file).mtimeMs; } catch { continue; }
    out.push({ file, mtime, callId: meta.toolUseId || '', kind: meta.agentType || 'helper', desc: meta.description || '' });
  }
  return out;
}

export function createParser(file = '', { sidechain = false } = {}) {
  const tools = new Map();   // tool_use id -> mapped tool (to read its result)
  const tasks = new Map();   // TaskCreate/TaskUpdate task list
  let pendingTask = new Map(); // tool_use id -> subject, until the result gives the task its id
  let meta = { cwd: '', branch: '', title: '' };

  const todosEvent = () => ({ t: 'todos', items: [...tasks.values()].filter(x => x.status !== 'deleted').map(x => ({ text: x.text, status: x.status })) });

  return function parse(o) {
    const out = [];
    if (!o || typeof o !== 'object') return out;

    if (o.cwd && (o.cwd !== meta.cwd || (o.gitBranch && o.gitBranch !== meta.branch))) {
      meta = { ...meta, cwd: o.cwd, branch: o.gitBranch || meta.branch };
      out.push({ t: 'meta', agent: label, cwd: meta.cwd, project: lastSeg(meta.cwd), branch: meta.branch, title: meta.title });
    }
    if (o.type === 'ai-title' && o.aiTitle) { meta.title = o.aiTitle; out.push({ t: 'meta', agent: label, cwd: meta.cwd, project: lastSeg(meta.cwd), branch: meta.branch, title: meta.title }); }
    if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') {
      let tokens = 0;
      for (const m of Object.values(o.modelUsage || {})) tokens += (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheCreationInputTokens || 0);
      out.push({ t: 'cost', usd: o.totalCostUSD, tokens });
    }
    if (o.type === 'system') {
      if (o.subtype === 'compact_boundary') out.push({ t: 'compact' });
      if (o.subtype === 'api_error') out.push({ t: 'retry', text: cut(textOf(o.content) || 'Lost the connection. Trying again…', 200) });
    }
    if ((o.isSidechain && !sidechain) || o.isMeta) return out;

    const msg = o.message;
    if (!msg) return out;

    if (o.type === 'user') {
      if (typeof msg.content === 'string') { if (!isPlumbing(msg.content)) out.push({ t: 'prompt', text: cut(msg.content, 1200) }); return out; }
      if (!Array.isArray(msg.content)) return out;
      const typed = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (typed && !isPlumbing(typed)) out.push({ t: 'prompt', text: cut(typed, 1200) });
      for (const b of msg.content) {
        if (b.type !== 'tool_result') continue;
        const tool = tools.get(b.tool_use_id);
        const r = resultFor(tool, b, o.toolUseResult);
        out.push({ t: 'result', id: b.tool_use_id, ...r });
        if (tool && tool.name === 'TaskCreate' && pendingTask.has(b.tool_use_id)) {
          const m = /#?(\d+)/.exec(textOf(b.content)) || [];
          const T = o.toolUseResult && o.toolUseResult.task;
          const tid = String((T && T.id) || m[1] || tasks.size + 1);
          tasks.set(tid, { text: pendingTask.get(b.tool_use_id), status: 'pending' });
          pendingTask.delete(b.tool_use_id);
          out.push(todosEvent());
        }
        if (tool && tool.job && r.ok) out.push({ t: 'job-end', job: tool.job });
        tools.delete(b.tool_use_id);
      }
      return out;
    }

    if (o.type === 'assistant') {
      const u = msg.usage;
      if (u) {
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
        if (used > 0) out.push({ t: 'usage', used, max: used > 200000 || /\[1m\]|1m/i.test(o.requestedModel || '') ? 1000000 : 200000 });
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && b.text && b.text.trim()) out.push({ t: 'say', text: cut(b.text, 1500) });
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push({ t: 'think', text: cut(b.thinking || '', 300) });
        else if (b.type === 'tool_use') {
          const input = b.input || {};
          if (b.name === 'TodoWrite') {
            tasks.clear();
            (input.todos || []).forEach((x, i) => tasks.set(String(i), { text: cut(x.content || x.subject, 160), status: x.status || 'pending' }));
            out.push(todosEvent());
            continue;
          }
          if (b.name === 'TaskCreate') { pendingTask.set(b.id, cut(input.subject || input.description, 160)); tools.set(b.id, { name: b.name }); continue; }
          if (b.name === 'TaskUpdate') {
            const x = tasks.get(String(input.taskId));
            if (x) { if (input.status) x.status = input.status; if (input.subject) x.text = cut(input.subject, 160); out.push(todosEvent()); }
            continue;
          }
          if (b.name === 'TaskList' || b.name === 'TaskGet' || b.name === 'TaskOutput' || b.name === 'BashOutput' || b.name === 'ToolSearch') continue;
          const tool = mapTool(b.name, input);
          tools.set(b.id, tool);
          out.push({ t: 'tool', id: b.id, ...tool });
        }
      }
    }
    return out;
  };
}
