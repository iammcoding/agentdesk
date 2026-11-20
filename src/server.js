/*
 * A small local web server: the desk page, a live event stream (Server-Sent Events), the session
 * list, and a hook endpoint for the Claude Code plugin. It listens on 127.0.0.1 only and refuses
 * requests whose Host isn't localhost, so other websites can't read your agent's logs.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');
const MAX_BODY = 2 << 20;

export function createServer(hub, { log = () => {} } = {}) {
  let port = 0;
  const okHost = h => {
    if (!h) return false;
    const host = h.replace(/:\d+$/, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  };

  const server = http.createServer((req, res) => {
    if (!okHost(req.headers.host)) { res.writeHead(403).end('AgentDesk only answers on localhost.'); return; }
    // Browsers send Origin on cross-site requests: only our own page may call us.
    const origin = req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin)) { res.writeHead(403).end(); return; }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      fs.readFile(UI, (err, buf) => {
        if (err) { res.writeHead(500).end('UI missing'); return; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(buf);
      });
      return;
    }

    const font = /^\/fonts\/([a-z0-9-]+\.(woff2|txt))$/i.exec(url.pathname);
    if (req.method === 'GET' && font) {
      fs.readFile(path.join(path.dirname(UI), 'fonts', font[1]), (err, buf) => {
        if (err) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': font[2] === 'txt' ? 'text/plain; charset=utf-8' : 'font/woff2', 'cache-control': 'max-age=86400' }).end(buf);
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1500\n\n');
      const client = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
      hub.addClient(client);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => { clearInterval(ping); hub.removeClient(client); });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      json(res, { mode: hub.mode, sessions: hub.sessionList() });
      return;
    }

    if (req.method === 'POST' && (url.pathname === '/watch' || url.pathname === '/hook')) {
      readBody(req, (err, body) => {
        if (err) { res.writeHead(413).end(); return; }
        let data;
        try { data = JSON.parse(body || '{}'); } catch { res.writeHead(400).end(); return; }
        if (url.pathname === '/hook') { hub.hook(data); res.writeHead(204).end(); return; }
        const file = data.file;
        if (file && file !== 'auto' && !hub.sessions().some(s => s.file === file)) { res.writeHead(404).end(); return; }
        hub.pin(file);
        json(res, { ok: true, mode: hub.mode });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') { json(res, { ok: true, app: 'agentdesk', port }); return; }

    res.writeHead(404).end();
  });

  server.on('listening', () => { port = server.address().port; });
  return server;
}

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let size = 0;
  const parts = [];
  req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); cb(new Error('too big')); return; } parts.push(c); });
  req.on('end', () => cb(null, Buffer.concat(parts).toString('utf8')));
  req.on('error', e => cb(e));
}

/* Tries the port, then the next few, so a second copy or a busy port doesn't stop it. */
export function listen(server, port, tries = 20) {
  return new Promise((resolve, reject) => {
    const attempt = p => {
      const onErr = e => {
        server.off('listening', onOk);
        if (e.code === 'EADDRINUSE' && tries-- > 0) attempt(p + 1);
        else reject(e);
      };
      const onOk = () => { server.off('error', onErr); resolve(server.address().port); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(p, '127.0.0.1');
    };
    attempt(port);
  });
}
