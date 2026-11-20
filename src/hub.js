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
    if (this.cur && this.cur.watch) this.cur.watch.stop();
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

  attach(file) {
    if (this.cur && this.cur.watch) this.cur.watch.stop();
    const a = this.adapterFor(file);
    const parse = a.createParser(file);
    const cur = { file, agent: a.id, label: a.label, events: [], sticky: {}, live: false, watch: null };
    this.cur = cur;
    this.log(`watching ${a.label}: ${file}`);
    this.send({ t: 'reset', agent: a.label, file, mode: this.mode });

    const take = (evs, replay) => {
      for (const ev of evs) {
        if (this.cur !== cur) return;
        if (ev.t === 'meta' || ev.t === 'todos' || ev.t === 'usage' || ev.t === 'cost') cur.sticky[ev.t] = ev;
        cur.events.push(ev);
        if (cur.events.length > KEEP) cur.events.splice(0, cur.events.length - KEEP);
        this.send(replay ? { ...ev, replay: true } : ev);
      }
    };

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

  /* ---------- hooks (from the Claude Code plugin) ---------- */
  hook(h) {
    if (!h || typeof h !== 'object') return;
    const tp = h.transcript_path;
    if (tp && this.mode === 'auto' && (!this.cur || path.resolve(tp) !== path.resolve(this.cur.file)) &&
        /^(SessionStart|UserPromptSubmit|PreToolUse)$/.test(h.hook_event_name || '')) {
      try { fs.accessSync(tp); this.attach(tp); } catch {}
    }
    if (!this.cur || (tp && path.resolve(tp) !== path.resolve(this.cur.file))) return;
    switch (h.hook_event_name) {
      case 'PermissionRequest':
        this.send({ t: 'permission', tool: h.tool_name || '', detail: permDetail(h.tool_name, h.tool_input) });
        break;
      case 'Notification':
        if (/permission/i.test(h.message || '') || h.notification_type === 'permission_prompt') this.send({ t: 'permission', tool: '', detail: String(h.message || '').slice(0, 300) });
        else if (h.notification_type === 'idle_prompt') this.send({ t: 'idle' });
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
      case 'UserPromptSubmit':
        this.send({ t: 'permission-done' });
        break;
      case 'Stop':
        this.send({ t: 'permission-done' });
        this.send({ t: 'idle' });
        break;
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
