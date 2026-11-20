/*
 * OpenAI Codex CLI writes $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (CODEX_HOME
 * defaults to ~/.codex). Each line is {timestamp, type, payload}. `response_item` lines carry the
 * conversation in both of Codex's history modes, so they are the main source here.
 * Format notes: github.com/openai/codex, codex-rs/protocol/src/models.rs and rollout/src/policy.rs.
 */
import os from 'node:os';
import path from 'node:path';
import { cut, textOf, IMAGE_EXT, lastSeg, isGit, isGh, isBrowserTool, tailLines } from '../events.js';

export const id = 'codex';
export const label = 'Codex';
export const format = 'jsonl';
export const depth = 4;
export const match = f => /rollout-[^\\/]*\.jsonl$/.test(f);

export function roots() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return [path.join(home, 'sessions')];
}

const jsonArgs = s => { if (s && typeof s === 'object') return s; try { return JSON.parse(s || '{}'); } catch { return { raw: String(s || '') }; } };
const shellCmd = a => {
  if (typeof a.cmd === 'string') return a.cmd;
  if (typeof a.command === 'string') return a.command;
  if (Array.isArray(a.command)) { const c = a.command; return c.length >= 3 && /sh$/.test(c[0]) && /^-l?c$/.test(c[1]) ? c.slice(2).join(' ') : c.join(' '); }
  return a.raw || '';
};
const itemsText = o => typeof o === 'string' ? o : Array.isArray(o) ? o.map(x => x && (x.text || '')).filter(Boolean).join('\n') : '';

/* apply_patch input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch" */
export function parsePatch(input) {
  const L = String(input || '').split('\n');
  const files = [];
  let cur = null;
  for (const l of L) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)$/.exec(l);
    if (m) { cur = { op: m[1], path: m[2].trim(), lines: [] }; files.push(cur); continue; }
    if (!cur || /^\*\*\* (End Patch|Move to:)/.test(l)) continue;
    if (/^[-+ ]/.test(l)) cur.lines.push(l);
  }
  return files;
}

/* Shell output: "…Process exited with code 0\n…Output:\n<text>", or older JSON {output, metadata:{exit_code}} */
function shellResult(out) {
  let text = itemsText(out);
  let code = null;
  try { const j = JSON.parse(text); if (j && typeof j === 'object' && 'output' in j) { text = String(j.output); code = j.metadata && j.metadata.exit_code; } } catch {}
  const m = /Process exited with code (-?\d+)/.exec(text);
  if (m) code = Number(m[1]);
  const i = text.indexOf('\nOutput:\n');
  if (i >= 0) text = text.slice(i + 9);
  return { ok: code == null ? !/^(error|failed)/i.test(text) : code === 0, lines: tailLines(text, 14).map(l => cut(l, 300)), exit: code };
}

function mapCall(name, a, namespace) {
  const base = { name };
  if (name === 'exec_command' || name === 'shell' || name === 'shell_command' || name === 'container.exec' || name === 'local_shell') {
    const command = shellCmd(a);
    return { ...base, app: 'term', command: cut(command, 2000), git: isGit(command), gh: isGh(command), background: false };
  }
  if (name === 'view_image') return { ...base, app: 'img', path: a.path };
  if (name === 'read_file') return { ...base, app: IMAGE_EXT.test(a.path || '') ? 'img' : 'ed', op: 'read', path: a.path || a.file_path };
  if (name === 'apply_patch') return patchTool(base, a.input || a.patch || a.raw);
  const mcp = namespace || (name.startsWith('mcp__') ? name.split('__')[1] : '');
  if (mcp) {
    const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') : name;
    if (isBrowserTool(mcp) || isBrowserTool(tool)) return { ...base, app: 'web', url: a.url || '', action: tool, server: mcp };
    return { ...base, app: 'net', server: mcp, tool };
  }
  return { ...base, app: 'other' };
}

function patchTool(base, input) {
  const files = parsePatch(input);
  const f = files[0] || { path: '', lines: [], op: 'Update' };
  const old = f.lines.filter(l => l[0] === '-').map(l => l.slice(1)).join('\n');
  const neu = f.lines.filter(l => l[0] === '+').map(l => l.slice(1)).join('\n');
  if (f.op === 'Add') return { ...base, name: 'apply_patch', app: 'ed', op: 'write', path: f.path, content: cut(neu, 20000), files: files.length };
  return { ...base, name: 'apply_patch', app: 'ed', op: 'edit', path: f.path, old: cut(old, 6000), new: cut(neu, 6000), files: files.length };
}

const isContext = t => /^\s*<(environment_context|user_instructions|permissions|collaboration_mode|turn_aborted|user_shell_command)/.test(t) || /^# AGENTS\.md/.test(t) || !t.trim();

export function createParser() {
  const calls = new Map();
  let meta = { cwd: '', branch: '' };
  const metaEv = () => ({ t: 'meta', agent: label, cwd: meta.cwd, project: lastSeg(meta.cwd), branch: meta.branch });

  return function parse(o) {
    const out = [];
    const p = o && o.payload;
    if (!p) return out;
    switch (o.type) {
      case 'session_meta': {
        const m = p.meta || p;
        meta = { cwd: m.cwd || meta.cwd, branch: (m.git && m.git.branch) || meta.branch };
        if (!m.parent_thread_id) out.push(metaEv());
        break;
      }
      case 'turn_context':
        if (p.cwd && p.cwd !== meta.cwd) { meta.cwd = p.cwd; out.push(metaEv()); }
        break;
      case 'compacted':
        out.push({ t: 'compact' });
        break;
      case 'event_msg':
        if (p.type === 'token_count' && p.info) {
          const last = p.info.last_token_usage || {}, total = p.info.total_token_usage || {};
          const used = (last.input_tokens || 0) + (last.output_tokens || 0);
          if (used) out.push({ t: 'usage', used, max: p.info.model_context_window || 272000 });
          if (total.total_tokens) out.push({ t: 'cost', usd: null, tokens: total.total_tokens });
        } else if (p.type === 'task_complete' || p.type === 'turn_aborted') out.push({ t: 'idle' });
        else if (p.type === 'context_compacted') out.push({ t: 'compact' });
        else if (p.type === 'stream_error' || p.type === 'error') out.push({ t: 'retry', text: cut(p.message || 'Connection problem. Trying again…', 200) });
        break;
      case 'response_item': {
        switch (p.type) {
          case 'message': {
            const text = itemsText(p.content);
            if (p.role === 'user' && !isContext(text)) out.push({ t: 'prompt', text: cut(text, 1200) });
            else if (p.role === 'assistant' && text.trim()) out.push({ t: 'say', text: cut(text, 1500) });
            break;
          }
          case 'reasoning':
            out.push({ t: 'think', text: cut((p.summary || []).map(s => s.text).filter(Boolean).join(' '), 300) });
            break;
          case 'function_call':
          case 'custom_tool_call':
          case 'local_shell_call': {
            const a = p.type === 'custom_tool_call' ? { input: p.input } : p.type === 'local_shell_call' ? (p.action || {}) : jsonArgs(p.arguments);
            const name = p.type === 'local_shell_call' ? 'local_shell' : p.name || 'tool';
            if (name === 'write_stdin') break;
            if (name === 'update_plan') {
              out.push({ t: 'todos', items: (a.plan || []).map(s => ({ text: cut(s.step, 160), status: s.status === 'completed' ? 'completed' : s.status === 'in_progress' ? 'in_progress' : 'pending' })) });
              break;
            }
            const tool = mapCall(name, a, p.namespace);
            calls.set(p.call_id || p.id, tool);
            out.push({ t: 'tool', id: p.call_id || p.id, ...tool });
            break;
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const tool = calls.get(p.call_id);
            if (!tool) break;
            calls.delete(p.call_id);
            let r;
            if (tool.app === 'term') r = shellResult(p.output);
            else {
              const text = itemsText(p.output);
              let ok = !/^(error|failed|apply_patch verification failed)/i.test(text.trim());
              try { const j = JSON.parse(text); if (j && j.metadata && 'exit_code' in j.metadata) ok = j.metadata.exit_code === 0; } catch {}
              r = { ok, text: cut(text, 1500) };
              const img = Array.isArray(p.output) && p.output.find(x => x && x.type === 'input_image' && x.image_url);
              if (img) r.image = img.image_url;
            }
            out.push({ t: 'result', id: p.call_id, ...r });
            break;
          }
          case 'web_search_call': {
            const q = (p.action && (p.action.query || (p.action.queries || [])[0])) || '';
            const id = p.id || 'ws' + Math.random().toString(36).slice(2);
            out.push({ t: 'tool', id, name: 'web_search', app: 'web', query: q });
            out.push({ t: 'result', id, ok: p.status !== 'failed', text: '' });
            break;
          }
          case 'compaction':
            out.push({ t: 'compact' });
            break;
        }
        break;
      }
    }
    return out;
  };
}
