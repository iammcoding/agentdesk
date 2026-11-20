/*
 * The hub finds agent sessions on disk, follows one (the newest, unless you pin one), turns its
 * log into desk events, and sends them to every open desk. It never writes to the agents' files.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Tail } from './tail.js';
import { lastSeg } from './events.js';

const KEEP = 600;             // recent events kept for a desk that opens later

export class Hub {
  constructor(adapters, { file = null, log = () => {} } = {}) {
    this.adapters = adapters;
    this.clients = new Set();
    this.mode = file ? 'pinned' : 'auto';
    this.pinnedFile = file;
    this.cur = null;
    this.log = log;
    this.metaCache = new Map();
  }

  start() {
    if (this.pinnedFile) this.attach(this.pinnedFile);
    else this.follow();
    this.scanTimer = setInterval(() => this.mode === 'auto' && this.follow(), 1500);
    if (this.scanTimer.unref) this.scanTimer.unref();
    return this;
  }

  stop() {
    clearInterval(this.scanTimer);
    this.detach();
  }

  /* ---------- finding sessions ---------- */
  sessions() {
    const out = [];
    for (const a of this.adapters) {
      for (const root of a.roots()) walk(root, a.depth, a.match, f => {
        try { const st = fs.statSync(f); out.push({ agent: a.id, label: a.label, file: f, mtime: st.mtimeMs, size: st.size }); } catch {}
      });
    }
    out.sort((x, y) => y.mtime - x.mtime);
    return out;
  }

  sessionList(limit = 30) {
    return this.sessions().slice(0, limit).map(s => ({ ...s, ...this.peekMeta(s), current: !!(this.cur && this.cur.file === s.file) }));
  }

  /* Project folder name for the session picker, read from the first part of the file. */
  peekMeta(s) {
    const hit = this.metaCache.get(s.file);
    if (hit) return hit;
    const a = this.adapters.find(x => x.id === s.agent);
    let project = a && a.projectOf ? a.projectOf(s.file) : '';
    if (!project) try {
      const fd = fs.openSync(s.file, 'r');
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const m = /"(?:cwd|workdir|projectRoot)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8', 0, n));
      if (m) project = lastSeg(JSON.parse('"' + m[1] + '"'));
    } catch {}
    const meta = { project };
    if (project) this.metaCache.set(s.file, meta);
    return meta;
  }

  follow() {
    const list = this.sessions();
    const newest = list[0];
    if (!newest) return;
    if (!this.cur) {
      this.attach(newest.file); // even an old session: the desk shows where it left off
      return;
    }
    if (newest.file === this.cur.file) return;
    const curM = list.find(s => s.file === this.cur.file);
    // Switch when another session is clearly the one being worked on now.
    if (!curM || newest.mtime - curM.mtime > 3000) this.attach(newest.file);
  }

  pin(file) {
    if (!file || file === 'auto') { this.mode = 'auto'; this.pinnedFile = null; this.follow(); return; }
    this.mode = 'pinned';
    this.pinnedFile = file;
    this.attach(file);
  }

  /* ---------- following one session ---------- */
  adapterFor(file) {
    const r = path.resolve(file);
    return this.adapters.find(a => a.roots().some(root => r.startsWith(path.resolve(root) + path.sep))) ||
      this.adapters.find(a => a.match(r)) || this.adapters[0];
  }

  detach() {
    const cur = this.cur;
    if (!cur) return;
    if (cur.watch) cur.watch.stop();
    for (const h of cur.helpers.values()) h.tail.stop();
    clearInterval(cur.helperTimer);
  }

  attach(file) {
    this.detach();
    const a = this.adapterFor(file);
    const parse = a.createParser(file);
    const cur = { file, adapter: a, agent: a.id, label: a.label, events: [], sticky: {}, live: false, watch: null,
      parse, seenTool: new Set(), seenResult: new Set(), helpers: new Map(), helperTimer: null, since: Date.now() };
    this.cur = cur;
    this.log(`watching ${a.label}: ${file}`);
    this.send({ t: 'reset', agent: a.label, file, mode: this.mode });

    /* The same tool call can arrive twice (once from a hook, once from the log): show it once. */
    const take = (evs, replay) => {
      for (const ev of evs) {
        if (this.cur !== cur) return;
        if (ev.t === 'tool' && ev.id) { if (cur.seenTool.has(ev.id)) continue; cur.seenTool.add(ev.id); }
        if (ev.t === 'result' && ev.id) { if (cur.seenResult.has(ev.id)) continue; cur.seenResult.add(ev.id); }
        if (ev.t === 'say' && cur.hookSay && String(ev.text).trim() === cur.hookSay) { cur.hookSay = null; continue; } // already shown from the Stop hook
        if (ev.t === 'say') cur.lastSay = String(ev.text).trim();
        if (ev.t === 'meta' || ev.t === 'todos' || ev.t === 'usage' || ev.t === 'cost') cur.sticky[ev.t] = ev;
        cur.events.push(ev);
        if (cur.events.length > KEEP) cur.events.splice(0, cur.events.length - KEEP);
        this.send(replay ? { ...ev, replay: true } : { ...ev, at: Date.now() });
      }
    };
    cur.take = take;

    if (a.helperFiles) {
      this.watchHelpers(cur);
      cur.helperTimer = setInterval(() => this.watchHelpers(cur), 700);
      if (cur.helperTimer.unref) cur.helperTimer.unref();
    }

    if (a.format === 'json') {
      cur.watch = new DocWatch(file, doc => take(parse(doc), !cur.live), () => { cur.live = true; this.send({ t: 'live' }); }).start();
    } else {
      cur.watch = new Tail(file, {
        onLine: (line, replay) => {
          let o;
          try { o = JSON.parse(line); } catch { return; }
          let evs;
          try { evs = parse(o); } catch (e) { this.log('parse error: ' + e.message); return; }
          take(evs, replay);
        },
        onBackfillDone: () => { cur.live = true; this.send({ t: 'live' }); },
      }).start();
    }
  }

  /* ---------- helper agents ---------- */
  /* Follows the log of each helper the session starts, and reports its steps one line at a time. */
  watchHelpers(cur) {
    if (this.cur !== cur) return;
    let list;
    try { list = cur.adapter.helperFiles(cur.file); } catch { return; }
    for (const h of list) {
      if (cur.helpers.has(h.file)) continue;
      if (h.mtime < cur.since - 5 * 60e3) { cur.helpers.set(h.file, { tail: { stop() {} } }); continue; } // finished long ago
      if (cur.helpers.size > 200) return;
      const parse = cur.adapter.createParser(h.file, { sidechain: true });
      const tail = new Tail(h.file, {
        backfillBytes: 128 * 1024,
        onLine: (line, replay) => {
          let evs;
          try { evs = parse(JSON.parse(line)); } catch { return; }
          for (const ev of evs) {
            const text = helperStep(ev);
            if (text) cur.take([{ t: 'helper', id: h.callId, kind: h.kind, text, ok: ev.t !== 'result' || ev.ok }], replay);
          }
        },
      }).start();
      cur.helpers.set(h.file, { tail });
    }
  }

  /* ---------- hooks (from the Claude Code plugin) ---------- */
  hook(h) {
    if (!h || typeof h !== 'object') return;
    const tp = h.transcript_path;
    if (tp && this.mode === 'auto' && (!this.cur || path.resolve(tp) !== path.resolve(this.cur.file)) &&
        /^(SessionStart|UserPromptSubmit|PreToolUse)$/.test(h.hook_event_name || '') && !h.agent_id) {
      try { fs.accessSync(tp); this.attach(tp); } catch {}
    }
    const cur = this.cur;
    if (!cur || (tp && path.resolve(tp) !== path.resolve(cur.file))) return;
    // Every hook means something just happened: read the log now instead of waiting for the next tick.
    if (cur.watch && cur.watch.poll) cur.watch.poll();
    if (h.agent_id) { for (const x of cur.helpers.values()) x.tail.poll && x.tail.poll(); this.watchHelpers(cur); return; } // a helper's own hook: its log covers it
    switch (h.hook_event_name) {
      case 'PreToolUse':
        // The tool is starting right now. Show it without waiting for the log line (same id, shown once).
        if (cur.live && cur.agent === 'claude' && h.tool_use_id && h.tool_name && !cur.seenTool.has(h.tool_use_id)) {
          try { cur.take(cur.parse({ type: 'assistant', message: { content: [{ type: 'tool_use', id: h.tool_use_id, name: h.tool_name, input: h.tool_input || {} }] } }), false); } catch {}
        }
        this.send({ t: 'permission-done' });
        break;
      case 'SubagentStart':
      case 'SubagentStop':
        this.watchHelpers(cur);
        break;
      case 'PostCompact':
        break; // the log's own compact line draws it
      case 'SessionEnd':
        this.send({ t: 'ended', reason: String(h.reason || '') });
        break;
      case 'PermissionRequest':
        cur.permAt = Date.now();
        this.send({ t: 'permission', tool: h.tool_name || '', detail: permDetail(h.tool_name, h.tool_input) });
        break;
      case 'Notification':
        // permission_prompt arrives ~6 s after the dialog opens; PermissionRequest (above) is the
        // early signal with the details, so this one only matters when that hook didn't fire.
        if (h.notification_type === 'permission_prompt' || (!h.notification_type && /permission/i.test(h.message || ''))) {
          if (Date.now() - (cur.permAt || 0) > 30000) this.send({ t: 'permission', tool: '', detail: String(h.message || '').slice(0, 300) });
        } else if (h.notification_type === 'elicitation_dialog' || h.notification_type === 'agent_needs_input') {
          this.send({ t: 'permission', tool: '', detail: String(h.message || 'Waiting for your answer').slice(0, 300) });
        } else if (h.notification_type === 'idle_prompt') this.send({ t: 'idle' });
        break;
      case 'StopFailure':
        this.send({ t: 'permission-done' });
        this.send({ t: 'retry', text: String(h.last_assistant_message || h.error_details || h.error || 'The request failed').slice(0, 200), at: Date.now() });
        this.send({ t: 'idle' });
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
      case 'UserPromptSubmit':
        this.send({ t: 'permission-done' });
        break;
      case 'Stop': {
        this.send({ t: 'permission-done' });
        // The log may not have the final message yet when Stop fires, so the hook carries it.
        const said = typeof h.last_assistant_message === 'string' ? h.last_assistant_message.trim() : '';
        const text = said.length > 1500 ? said.slice(0, 1500) + '…' : said;
        if (text && cur.live && cur.agent === 'claude' && text !== cur.lastSay) { cur.take([{ t: 'say', text }], false); cur.hookSay = text; }
        this.send({ t: 'idle' });
        break;
      }
      case 'PreCompact':
        this.send({ t: 'compacting' });
        break;
    }
  }

  /* ---------- desks ---------- */
  addClient(c) {
    this.clients.add(c);
    const cur = this.cur;
    if (!cur) { c({ t: 'waiting' }); return; }
    c({ t: 'reset', agent: cur.label, file: cur.file, mode: this.mode });
    for (const k of ['meta', 'todos']) if (cur.sticky[k] && !cur.events.includes(cur.sticky[k])) c({ ...cur.sticky[k], replay: true });
    for (const ev of cur.events) c({ ...ev, replay: true });
    for (const k of ['usage', 'cost']) if (cur.sticky[k]) c({ ...cur.sticky[k], replay: true });
    if (cur.live) c({ t: 'live' });
  }

  removeClient(c) { this.clients.delete(c); }

  send(ev) { for (const c of this.clients) { try { c(ev); } catch {} } }
}

/* One line for what a helper just did, or '' for things not worth a line. */
function helperStep(ev) {
  if (ev.t === 'result') return ev.ok ? '' : '✕ ' + String(ev.text || (ev.lines || []).filter(Boolean).pop() || 'failed').split('\n')[0].slice(0, 120);
  if (ev.t === 'say') return '“' + String(ev.text).replace(/\s+/g, ' ').slice(0, 140) + '”';
  if (ev.t !== 'tool') return '';
  const b = p => lastSeg(p) || String(p || '');
  switch (ev.app) {
    case 'ed': return (ev.op === 'read' ? 'Read ' : ev.op === 'write' ? 'Write ' : 'Edit ') + b(ev.path);
    case 'img': return 'Look at ' + b(ev.path);
    case 'term': return '$ ' + String(ev.command || '').split('\n')[0].slice(0, 120);
    case 'files': return (ev.grep ? 'Search ' : 'Find ') + String(ev.pattern || '').slice(0, 80);
    case 'web': return ev.query ? 'Search the web: ' + String(ev.query).slice(0, 80) : 'Open ' + String(ev.url || ev.action || '').slice(0, 100);
    case 'net': return `${ev.server}.${ev.tool}`;
    case 'help': return 'Start a helper: ' + String(ev.desc || '').slice(0, 80);
    default: return ev.name ? 'Use ' + ev.name : '';
  }
}

function permDetail(name, input = {}) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.url || input.query || input.notebook_path || '';
  return String(v || JSON.stringify(input)).slice(0, 300);
}

/* Lists files up to `depth` folders below root, skipping helper-agent folders. */
function walk(root, depth, match, cb) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) { if (depth > 1 && e.name !== 'subagents' && e.name !== 'tool-results' && e.name !== 'memory') walk(p, depth - 1, match, cb); }
    else if (e.isFile() && match(p)) cb(p);
  }
}

/* For agents that rewrite one JSON document instead of appending lines. */
class DocWatch {
  constructor(file, onDoc, onFirst) { this.file = file; this.onDoc = onDoc; this.onFirst = onFirst; this.mtime = 0; }
  start() {
    this.check(true);
    this.timer = setInterval(() => this.check(false), 500);
    if (this.timer.unref) this.timer.unref();
    return this;
  }
  check(first) {
    try {
      const st = fs.statSync(this.file);
      if (st.mtimeMs !== this.mtime) {
        this.mtime = st.mtimeMs;
        const doc = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.onDoc(doc);
      }
    } catch { /* half-written: try again next tick */ }
    if (first) this.onFirst();
  }
  stop() { clearInterval(this.timer); }
}
