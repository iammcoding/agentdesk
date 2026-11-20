/*
 * GitHub Copilot CLI (experimental): ~/.copilot/session-state/<session>/events.jsonl
 * (COPILOT_HOME overrides ~/.copilot). Event names come from the Copilot SDK docs; GitHub
 * hasn't published a schema for the file, so this adapter reads it loosely.
 */
import os from 'node:os';
import path from 'node:path';
import { cut, IMAGE_EXT, lastSeg, isGit, isGh, tailLines } from '../events.js';

export const id = 'copilot';
export const label = 'Copilot CLI';
export const format = 'jsonl';
export const depth = 2;
export const match = f => /[\\/]events\.jsonl$/.test(f);

export function roots() {
  const home = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
  return [path.join(home, 'session-state')];
}

const str = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'object' && typeof v.text === 'string' ? v.text : JSON.stringify(v));

function mapTool(name, a = {}) {
  const n = String(name || '').toLowerCase();
  const file = a.path || a.file_path || a.filePath;
  if (/bash|shell|powershell|terminal|exec/.test(n)) { const c = a.command || a.cmd || ''; return { name, app: 'term', command: cut(c, 2000), git: isGit(c), gh: isGh(c), background: !!a.async }; }
  if (/str_replace|edit/.test(n)) return { name, app: 'ed', op: 'edit', path: file, old: cut(a.old_str || a.old_string, 6000), new: cut(a.new_str || a.new_string, 6000) };
  if (/create|write/.test(n)) return { name, app: 'ed', op: 'write', path: file, content: cut(a.file_text || a.content, 20000) };
  if (/view|read/.test(n)) return IMAGE_EXT.test(file || '') ? { name, app: 'img', path: file } : { name, app: 'ed', op: 'read', path: file };
  if (/grep|search_code/.test(n)) return { name, app: 'files', pattern: a.pattern || a.query, grep: true };
  if (/glob|find|list/.test(n)) return { name, app: 'files', pattern: a.pattern || '*', path: file };
  if (/fetch|url/.test(n)) return { name, app: 'web', url: a.url };
  if (/web_search|search_web/.test(n)) return { name, app: 'web', query: a.query };
  if (/github|mcp/.test(n)) return { name, app: 'net', server: 'github', tool: name };
  return { name, app: 'other' };
}

export function createParser() {
  const tools = new Map();
  return function parse(o) {
    const out = [];
    const type = o && o.type;
    const d = (o && o.data) || {};
    if (!type) return out;
    if (/^session\.(start|resume)/.test(type)) {
      const cwd = d.cwd || (d.context && d.context.cwd) || '';
      out.push({ t: 'meta', agent: label, cwd, project: lastSeg(cwd), branch: (d.context && d.context.branch) || '' });
    } else if (type === 'user.message') {
      const t = str(d.content);
      if (t.trim()) out.push({ t: 'prompt', text: cut(t, 1200) });
    } else if (type === 'assistant.message') {
      const t = str(d.content);
      if (t.trim()) out.push({ t: 'say', text: cut(t, 1500) });
    } else if (type === 'assistant.reasoning') {
      out.push({ t: 'think', text: cut(str(d.content), 300) });
    } else if (type === 'tool.execution_start') {
      let a = d.arguments;
      if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      const tool = mapTool(d.toolName, a || {});
      tools.set(d.toolCallId, tool);
      out.push({ t: 'tool', id: d.toolCallId, ...tool });
    } else if (type === 'tool.execution_complete') {
      const tool = tools.get(d.toolCallId);
      if (!tool) return out;
      tools.delete(d.toolCallId);
      const text = str(d.result && (d.result.content ?? d.result)) || str(d.error);
      const r = { t: 'result', id: d.toolCallId, ok: d.success !== false && !d.error };
      if (tool.app === 'term') r.lines = tailLines(text, 14).map(l => cut(l, 300));
      else r.text = cut(text, 1500);
      out.push(r);
    } else if (type === 'session.idle' || type === 'assistant.turn_end') {
      out.push({ t: 'idle' });
    } else if (type === 'session.usage_info' || type === 'assistant.usage') {
      const used = d.currentTokens || d.inputTokens || 0;
      if (used) out.push({ t: 'usage', used, max: d.tokenLimit || 200000 });
    }
    return out;
  };
}
