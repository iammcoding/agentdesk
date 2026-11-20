/*
 * Google Gemini CLI appends JSONL to ~/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl.
 * A message is appended again, whole, each time it changes (tokens, tool calls, results), so this
 * parser remembers what it has already shown per message and per tool call.
 * Format notes: github.com/google-gemini/gemini-cli, packages/core/src/services/chatRecordingService.ts
 */
import os from 'node:os';
import path from 'node:path';
import { cut, textOf, IMAGE_EXT, isGit, isGh, isBrowserTool, tailLines, outLines } from '../events.js';

export const id = 'gemini';
export const label = 'Gemini CLI';
export const format = 'jsonl';
export const depth = 3;
export const match = f => /session-[^\\/]*\.jsonl$/.test(f) && /[\\/]chats[\\/]/.test(f);

export function roots() {
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  return [path.join(home, '.gemini', 'tmp'), path.join(home, '.cache', '.gemini', 'tmp')];
}

/* The project folder's name is the folder under tmp/ (older versions used a hash there). */
export const projectOf = f => { const p = f.split(/[\\/]/); const i = p.lastIndexOf('chats'); const slug = i > 0 ? p[i - 1] : ''; return /^[0-9a-f]{40,}$/.test(slug) ? '' : slug; };

const partsText = c => {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return c && typeof c.text === 'string' ? c.text : '';
  return c.map(x => (typeof x === 'string' ? x : x && x.text) || '').filter(Boolean).join('\n');
};

function resultText(tc) {
  const r = tc.result;
  const parts = Array.isArray(r) ? r : r ? [r] : [];
  for (const x of parts) {
    const fr = x && x.functionResponse;
    if (fr && fr.response) {
      const v = fr.response.output ?? fr.response.error ?? fr.response.llmContent ?? fr.response.result;
      if (v != null) return typeof v === 'string' ? v : JSON.stringify(v);
    }
  }
  if (typeof tc.resultDisplay === 'string') return tc.resultDisplay;
  return partsText(r);
}

function resultImage(tc) {
  const parts = Array.isArray(tc.result) ? tc.result : [];
  for (const x of parts) if (x && x.inlineData && x.inlineData.data) return `data:${x.inlineData.mimeType || 'image/png'};base64,${x.inlineData.data}`;
  return null;
}

export function mapTool(name, a = {}) {
  const base = { name };
  const file = a.file_path || a.absolute_path || a.path;
  switch (name) {
    case 'run_shell_command': return { ...base, app: 'term', command: cut(a.command, 2000), desc: cut(a.description, 200), background: !!a.is_background, git: isGit(a.command), gh: isGh(a.command) };
    case 'replace':
    case 'edit': return { ...base, app: 'ed', op: 'edit', path: file, old: cut(a.old_string, 6000), new: cut(a.new_string, 6000) };
    case 'write_file': return { ...base, app: 'ed', op: 'write', path: file, content: cut(a.content, 20000) };
    case 'read_file': return IMAGE_EXT.test(file || '') ? { ...base, app: 'img', path: file } : { ...base, app: 'ed', op: 'read', path: file, offset: a.offset };
    case 'read_many_files': return { ...base, app: 'files', pattern: cut([].concat(a.paths || a.include || []).join(' '), 120) };
    case 'glob': return { ...base, app: 'files', pattern: a.pattern, path: a.path || a.dir_path };
    case 'grep_search':
    case 'search_file_content': return { ...base, app: 'files', pattern: a.pattern, path: a.path || a.dir_path, grep: true };
    case 'list_directory': return { ...base, app: 'files', pattern: '*', path: a.path || a.dir_path };
    case 'web_fetch': return { ...base, app: 'web', url: a.url || ((/https?:\/\/\S+/.exec(a.prompt || '') || [])[0]) || '' };
    case 'google_web_search': return { ...base, app: 'web', query: a.query };
    case 'ask_user': {
      const q = (a.questions && a.questions[0]) || a;
      return { ...base, app: 'ask', question: cut(q.question || q.prompt, 400), header: q.header, options: (q.options || []).slice(0, 5).map(o => (typeof o === 'string' ? { label: cut(o, 80) } : { label: cut(o.label, 80), description: cut(o.description, 160) })) };
    }
  }
  if (name.includes('__')) {
    const [server, ...rest] = name.split('__');
    const tool = rest.join('__');
    if (isBrowserTool(server) || isBrowserTool(tool)) return { ...base, app: 'web', url: a.url || '', action: tool, server };
    return { ...base, app: 'net', server, tool };
  }
  return { ...base, app: 'other' };
}

export function createParser(file = '') {
  const shownMsg = new Set();          // message ids whose text was shown
  const thoughtCount = new Map();      // message id -> thoughts shown
  const toolState = new Map();         // tool call id -> 'started' | 'done'
  const tokensBy = new Map();          // message id -> total tokens
  const tools = new Map();
  let started = false;

  const finish = (tc, out) => {
    const st = toolState.get(tc.id);
    if (st === 'done') return;
    const t = tools.get(tc.id) || {};
    const text = resultText(tc);
    const r = { t: 'result', id: tc.id, ok: tc.status === 'success' };
    if (t.app === 'term') r.lines = outLines(text).map(l => cut(l, 300));
    else if (t.app === 'ed' && t.op === 'read' && r.ok) { r.lines = text.split('\n').slice(0, 400).map(l => cut(l, 300)); r.start = (t.offset || 0) + 1; }
    else r.text = cut(text, 1500);
    const img = resultImage(tc);
    if (img) r.image = img;
    toolState.set(tc.id, 'done');
    out.push(r);
  };

  return function parse(o) {
    const out = [];
    if (!o || typeof o !== 'object') return out;
    if (!started && o.sessionId && !o.type) {
      started = true;
      const project = projectOf(file);
      const cwd = (o.directories && o.directories[0]) || '';
      out.push({ t: 'meta', agent: label, cwd, project: project || (cwd ? cwd.split(/[\\/]/).pop() : ''), branch: '' });
      return out;
    }
    if (o.$patch && Array.isArray(o.$patch.toolCalls)) {
      for (const tc of o.$patch.toolCalls) if (tc.id && toolState.get(tc.id) === 'started' && tc.result) finish({ ...tc, status: tc.status || 'success' }, out);
      return out;
    }
    if (!o.id || !o.type) return out;

    if (o.type === 'user') {
      const text = partsText(o.displayContent || o.content);
      if (!shownMsg.has(o.id) && text.trim() && !text.trim().startsWith('<')) { shownMsg.add(o.id); out.push({ t: 'prompt', text: cut(text, 1200) }); }
      return out;
    }
    if (o.type === 'error') { if (!shownMsg.has(o.id)) { shownMsg.add(o.id); out.push({ t: 'retry', text: cut(partsText(o.content), 200) }); } return out; }
    if (o.type !== 'gemini') return out;

    const th = o.thoughts || [];
    for (let i = thoughtCount.get(o.id) || 0; i < th.length; i++) out.push({ t: 'think', text: cut(th[i].subject || th[i].description || '', 300) });
    thoughtCount.set(o.id, th.length);

    for (const tc of o.toolCalls || []) {
      if (!tc || !tc.id) continue;
      if (!toolState.has(tc.id)) {
        if (tc.name === 'write_todos') {
          const items = ((tc.args || {}).todos || []).map(x => ({ text: cut(x.description || x.content || x.text, 160), status: x.status === 'completed' ? 'completed' : x.status === 'in_progress' ? 'in_progress' : 'pending' }));
          out.push({ t: 'todos', items });
          toolState.set(tc.id, 'done');
          continue;
        }
        const tool = mapTool(tc.name || 'tool', tc.args || {});
        tools.set(tc.id, tool);
        toolState.set(tc.id, 'started');
        out.push({ t: 'tool', id: tc.id, ...tool });
      }
      if (/^(success|error|cancelled)$/.test(tc.status || '')) finish(tc, out);
    }

    const text = partsText(o.content);
    if (text.trim() && !shownMsg.has(o.id)) { shownMsg.add(o.id); out.push({ t: 'say', text: cut(text, 1500) }); }

    if (o.tokens) {
      const used = (o.tokens.input || 0) + (o.tokens.output || 0);
      if (used) out.push({ t: 'usage', used, max: 1048576 });
      tokensBy.set(o.id, o.tokens.total || used);
      let sum = 0; for (const v of tokensBy.values()) sum += v;
      out.push({ t: 'cost', usd: null, tokens: sum });
    }
    return out;
  };
}
