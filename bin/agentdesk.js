#!/usr/bin/env node
/*
 * agentdesk: opens a little desktop in your browser that shows what your coding agent is doing.
 * It only reads the agent's session logs on this computer. Nothing is sent anywhere.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Hub } from '../src/hub.js';
import { createServer, listen } from '../src/server.js';
import { ADAPTERS } from '../src/adapters/index.js';

const HELP = `
  agentdesk: watch your coding agent work.

  Usage
    npx agentdesk               follow the agent you're using right now
    npx agentdesk --demo        play a sample session

  Options
    --port <n>      port to use (default 4747, or the next free one)
    --agent <name>  only follow one agent: ${ADAPTERS.map(a => a.id).join(', ')}
    --file <path>   follow this session log
    --no-open       don't open the browser
    --list          list recent sessions and exit
    -h, --help      show this
`;

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

if (flag('-h') || flag('--help')) { console.log(HELP); process.exit(0); }
if (flag('-v') || flag('--version')) {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const only = val('--agent');
const adapters = only ? ADAPTERS.filter(a => a.id === only) : ADAPTERS;
if (!adapters.length) { console.error(`Unknown agent "${only}". Try: ${ADAPTERS.map(a => a.id).join(', ')}`); process.exit(1); }

const file = val('--file') ? path.resolve(val('--file')) : null;
if (file && !fs.existsSync(file)) { console.error(`No such file: ${file}`); process.exit(1); }

const hub = new Hub(adapters, { file, log: m => process.env.AGENTDESK_DEBUG && console.log('  · ' + m) });

if (flag('--list')) {
  const list = hub.sessionList(20);
  if (!list.length) console.log('No sessions found yet.');
  for (const s of list) console.log(`  ${new Date(s.mtime).toLocaleString()}  ${s.label.padEnd(12)} ${(s.project || '').padEnd(24)} ${s.file}`);
  process.exit(0);
}

const server = createServer(hub);
const port = await listen(server, Number(val('--port')) || 4747).catch(e => { console.error(e.message); process.exit(1); });
hub.start();

/* The plugin's hook script reads this to find us. Removed on exit. */
const dir = path.join(os.homedir(), '.agentdesk');
const portFile = path.join(dir, 'port');
try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(portFile, String(port)); } catch {}
const cleanup = () => { try { if (fs.readFileSync(portFile, 'utf8') === String(port)) fs.unlinkSync(portFile); } catch {} process.exit(0); };
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

const url = `http://localhost:${port}/${flag('--demo') ? '?demo' : ''}`;
const cur = hub.cur;
console.log(`\n  AgentDesk is running at ${url}`);
console.log(cur ? `  Watching ${cur.label}: ${cur.file}` : `  Waiting for an agent. Start ${adapters.map(a => a.label).join(', ')} in any folder.`);
console.log('  Press Ctrl+C to stop.\n');

if (!flag('--no-open')) openBrowser(url);

function openBrowser(u) {
  const cmd = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}
