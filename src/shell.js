/*
 * Reads a shell command and says which window can show it better than the Shell:
 *   cat/head/tail/sed -n … file   -> Editor (read)        sed -i … file      -> Editor (edit)
 *   grep/rg/find/fd/ls/tree       -> Files                curl/wget          -> Web
 *   git …                         -> Git                  test runners       -> Tests
 *   package installs              -> Packages
 * Only clear cases are mapped. Anything chained, piped into other tools, redirected to a file, or
 * using $(…) stays in the Shell, so the desk never shows something that didn't happen.
 */

/* Splits a command into words and operators, respecting quotes. Returns null if it can't. */
export function tokenize(cmd) {
  const out = [];
  let cur = '', has = false, q = null;
  const push = () => { if (has) out.push({ v: cur }); cur = ''; has = false; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if ((c === '$' && cmd[i + 1] === '(') || c === '`') { if (q === '"') return null; cur += c; }
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { cur += cmd[++i]; has = true; continue; }
    if (c === '`' || (c === '$' && cmd[i + 1] === '(') || (c === '<' && cmd[i + 1] === '(')) return null;
    if (c === '\n') { push(); out.push({ op: ';' }); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '|' || c === '&' || c === ';' || c === '>' || c === '<') {
      // 2>&1, 2>/dev/null, >/dev/null, &>/dev/null: harmless plumbing, swallowed here
      const m = /^(?:&?>>?|<)\s*(?:&\d|\/dev\/null)(?=\s|$|[|&;])/.exec(cmd.slice(i));
      if (m && c !== '|' && c !== ';') {
        if (has && /^\d$/.test(cur)) { cur = ''; has = false; } // the "2" of 2>&1
        push(); i += m[0].length - 1; continue;
      }
      push();
      const two = cmd.slice(i, i + 2);
      if (two === '&&' || two === '||' || two === '>>') { out.push({ op: two }); i++; }
      else out.push({ op: c });
      continue;
    }
    cur += c; has = true;
  }
  if (q) return null;
  push();
  return out;
}

const base = p => String(p || '').split(/[\\/]/).pop();
const PASS_THROUGH = new Set(['head', 'tail', 'cat', 'sort', 'uniq', 'less', 'more']);
const GIT_SUBS = new Set(['status', 'diff', 'log', 'show', 'branch', 'commit', 'add', 'checkout', 'switch', 'restore', 'push', 'pull', 'fetch', 'merge', 'rebase', 'stash', 'tag', 'reset', 'rm', 'mv', 'blame', 'remote', 'init', 'clone', 'cherry-pick', 'revert']);

/* Non-flag arguments, skipping the values of flags known to take one. */
function plain(args, valueFlags = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) { if (valueFlags.includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

function gitSub(argv) {
  let i = 1;
  while (i < argv.length && argv[i].startsWith('-')) i += (argv[i] === '-C' || argv[i] === '-c') ? 2 : 1;
  return GIT_SUBS.has(argv[i]) ? argv[i] : null;
}

function testRunner(argv) {
  const [c, a, b] = [base(argv[0]), argv[1] || '', argv[2] || ''];
  if (/^(npm|pnpm|yarn|bun)$/.test(c) && (a === 'test' || a === 't' || (a === 'run' && /^test/.test(b)) || /^test:/.test(a))) return c + ' test';
  if (/^(npx|pnpx|bunx)$/.test(c) && /^(jest|vitest|mocha|ava|playwright|cypress)$/.test(a)) return a;
  if (/^(jest|vitest|mocha|pytest|rspec|phpunit|ava)$/.test(c)) return c;
  if (/^python3?$/.test(c) && a === '-m' && /^(pytest|unittest)$/.test(b)) return b;
  if (/^(go|cargo|flutter|dart|dotnet|mvn|gradle|deno|bun|swift|mix)$/.test(c) && a === 'test') return c + ' test';
  if (c === 'gradlew' && argv.includes('test')) return 'gradle test';
  if (c === 'node' && argv.includes('--test')) return 'node --test';
  if (c === 'bundle' && a === 'exec' && b === 'rspec') return 'rspec';
  if (c === 'uv' && a === 'run' && b === 'pytest') return 'pytest';
  return null;
}

function installer(argv) {
  const [c, a, b] = [base(argv[0]), argv[1] || '', argv[2] || ''];
  const pk = from => plain(argv.slice(from), ['-r', '--requirement', '--registry', '-c', '--index-url', '-i', '--prefix']).slice(0, 12);
  if (/^(npm|pnpm|yarn|bun)$/.test(c) && /^(install|i|ci|add)$/.test(a)) return { manager: c, packages: pk(2) };
  if (/^pip3?$/.test(c) && a === 'install') return { manager: 'pip', packages: pk(2) };
  if (/^python3?$/.test(c) && a === '-m' && b === 'pip' && argv[3] === 'install') return { manager: 'pip', packages: pk(4) };
  if (c === 'uv' && (a === 'add' || a === 'sync')) return { manager: 'uv', packages: pk(2) };
  if (c === 'uv' && a === 'pip' && b === 'install') return { manager: 'uv', packages: pk(3) };
  if (/^(flutter|dart)$/.test(c) && a === 'pub' && /^(get|add|upgrade)$/.test(b)) return { manager: c + ' pub', packages: pk(3) };
  if (c === 'cargo' && /^(add|install)$/.test(a)) return { manager: 'cargo', packages: pk(2) };
  if (c === 'go' && (a === 'get' || (a === 'mod' && /^(tidy|download)$/.test(b)))) return { manager: 'go', packages: a === 'get' ? pk(2) : [] };
  if (/^(bundle|composer|poetry)$/.test(c) && /^(install|add|require|update)$/.test(a)) return { manager: c, packages: pk(2) };
  if (c === 'brew' && a === 'install') return { manager: 'brew', packages: pk(2) };
  if (c === 'pod' && a === 'install') return { manager: 'pod', packages: [] };
  return null;
}

function one(argv) {
  const c = base(argv[0]);
  const args = argv.slice(1);
  if (c === 'cat' || c === 'bat' || c === 'less' || c === 'more' || c === 'nl') {
    const f = plain(args);
    return f.length === 1 ? { kind: 'read', path: f[0], start: 1 } : null;
  }
  if (c === 'head' || c === 'tail') {
    if (args.includes('-f') || args.includes('-F')) return null;
    const f = plain(args, ['-n', '-c']);
    return f.length === 1 ? { kind: 'read', path: f[0], start: c === 'head' ? 1 : null } : null;
  }
  if (c === 'sed') {
    const inPlace = args.some(a => /^-i|^--in-place/.test(a));
    let rest = args.slice(), script = null;
    const e = rest.indexOf('-e');
    if (e >= 0) { script = rest[e + 1]; rest.splice(e, 2); }
    // BSD sed takes a separate (often empty) backup suffix after -i
    rest = rest.filter((a, i) => !(a === '' && rest[i - 1] === '-i'));
    const p = rest.filter(a => !/^-/.test(a));
    if (script == null) script = p.shift();
    if (!script || p.length !== 1) return null;
    if (inPlace) {
      const view = { kind: 'edit', path: p[0], rule: script };
      const d = script[1];
      if (script[0] === 's' && d && !/[\w\s\\]/.test(d)) {
        const parts = script.slice(2).split(new RegExp('(?<!\\\\)\\' + d));
        if (parts.length >= 2) { view.old = parts[0]; view.new = parts[1]; }
      }
      return view;
    }
    const m = /^(\d+)(?:,(\d+))?p$/.exec(script);
    return args.includes('-n') && m ? { kind: 'read', path: p[0], start: Number(m[1]), end: Number(m[2] || m[1]) } : null;
  }
  if (/^(grep|egrep|fgrep|rg|ag|ack)$/.test(c)) {
    let pattern = null;
    const e = args.findIndex(a => a === '-e' || a === '--regexp');
    const rest = args.slice();
    if (e >= 0) { pattern = rest[e + 1]; rest.splice(e, 2); }
    const p = plain(rest, ['-A', '-B', '-C', '-m', '-f', '-g', '-t', '-T', '--include', '--exclude', '--exclude-dir', '--glob', '--type', '--max-count', '-d', '-j']);
    if (pattern == null) pattern = p.shift();
    if (!pattern) return null;
    return { kind: 'search', pattern, path: p.join(' ') };
  }
  if (c === 'find' || c === 'fd' || c === 'fdfind') {
    if (c === 'find') {
      if (args.some(a => /^-(exec|execdir|delete|ok)$/.test(a))) return null;
      const n = args.findIndex(a => /^-i?(name|path|regex)$/.test(a));
      const dir = args[0] && !args[0].startsWith('-') ? args[0] : '.';
      return { kind: 'find', pattern: n >= 0 ? args[n + 1] : '*', path: dir };
    }
    if (args.some(a => /^-(x|X|-exec|-exec-batch)$/.test(a))) return null;
    const p = plain(args, ['-e', '--extension', '-t', '--type', '-d', '--max-depth', '-E', '--exclude']);
    return { kind: 'find', pattern: p[0] || '*', path: p[1] || '.' };
  }
  if (c === 'ls' || c === 'tree' || c === 'eza' || c === 'exa') {
    const p = plain(args, ['-L', '-I']);
    return p.length <= 1 ? { kind: 'list', path: p[0] || '.' } : null;
  }
  if (c === 'curl' || c === 'wget' || c === 'http' || c === 'https') {
    const url = args.find(a => /^https?:\/\//.test(a));
    if (!url) return null;
    const x = args.indexOf('-X') >= 0 ? args[args.indexOf('-X') + 1] : args.indexOf('--request') >= 0 ? args[args.indexOf('--request') + 1] : null;
    const sends = args.some(a => /^(-d|--data|--data-raw|--data-binary|-F|--form|--json|-T)$/.test(a));
    return { kind: 'web', url, method: (x || (sends ? 'POST' : 'GET')).toUpperCase() };
  }
  if (c === 'git') { const sub = gitSub(argv); return sub ? { kind: 'git', subs: [sub] } : null; }
  const runner = testRunner(argv);
  if (runner) return { kind: 'test', runner };
  const inst = installer(argv);
  if (inst) return { kind: 'install', ...inst };
  return null;
}

/* The view for a command, or null to leave it in the Shell. */
export function classify(command) {
  if (typeof command !== 'string' || !command.trim() || command.length > 4000) return null;
  const toks = tokenize(command.trim());
  if (!toks) return null;
  // split into steps (&&, ;) and each step into pipe stages
  const steps = [[[]]];
  for (const t of toks) {
    if (t.op === '&&' || t.op === ';') steps.push([[]]);
    else if (t.op === '|') steps[steps.length - 1].push([]);
    else if (t.op) return null; // ||, &, >, <: not a plain run
    else steps[steps.length - 1][steps[steps.length - 1].length - 1].push(t.v);
  }
  let cwd = null;
  const real = [], vars = {};
  const expand = w => w.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, a, b) => vars[a || b] ?? m);
  for (const stages of steps) {
    let argv = stages[0];
    const assigns = [];
    while (argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) { assigns.push(argv[0]); argv = argv.slice(1); } // FOO=bar cmd
    if (!argv.length) { // a bare "P=/some/dir" step: later words may use $P
      if (stages.length > 1) return null;
      for (const a of assigns) { const i = a.indexOf('='); vars[a.slice(0, i)] = expand(a.slice(i + 1)); }
      continue;
    }
    argv = argv.map(expand);
    if (argv[0] === 'cd' && stages.length === 1) { if (real.length) return null; cwd = argv[1] || null; continue; }
    if (stages.slice(1).some(s => !s.length || !PASS_THROUGH.has(base(s[0])) || s.includes('-f'))) return null;
    real.push({ argv, piped: stages.length > 1 });
  }
  if (!real.length) return null;
  let view;
  if (real.length === 1) view = one(real[0].argv);
  else {
    // several steps are fine only when every one is git (git add … && git commit …)
    const subs = real.map(r => (base(r.argv[0]) === 'git' ? gitSub(r.argv) : null));
    if (subs.some(s => !s)) return null;
    view = { kind: 'git', subs };
  }
  if (!view) return null;
  if (real.some(r => r.piped) && view.kind === 'read' && view.start === 1) view.start = null; // cat x | tail: line numbers unknown
  if (cwd) view.cwd = cwd;
  return view;
}

export const VIEW_APP = { read: 'ed', edit: 'ed', search: 'files', find: 'files', list: 'files', web: 'web', git: 'git', test: 'test', install: 'pkg' };

/* ---------- reading the output ---------- */
const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };

export function testSummary(lines) {
  const text = lines.join('\n');
  let passed = null, failed = null, skipped = null;
  let m;
  if ((m = /Tests:\s+(.*?)(\d+) total/.exec(text))) { // jest, vitest summary line
    passed = num(/(\d+) passed/, m[1]) ?? 0; failed = num(/(\d+) failed/, m[1]) ?? 0; skipped = num(/(\d+) skipped/, m[1]);
  } else if ((m = /^\s*Tests\s+(.*)$/m.exec(text)) && /passed|failed/.test(m[1])) { // vitest "Tests  2 failed | 5 passed"
    passed = num(/(\d+) passed/, m[1]) ?? 0; failed = num(/(\d+) failed/, m[1]) ?? 0; skipped = num(/(\d+) skipped/, m[1]);
  } else if (/^# pass \d+/m.test(text)) { // node --test, TAP
    passed = num(/^# pass (\d+)/m, text); failed = num(/^# fail (\d+)/m, text) ?? 0; skipped = num(/^# skipped (\d+)/m, text);
  } else if ((m = /=+ (.*) in [\d.]+s/.exec(text)) && /passed|failed|error/.test(m[1])) { // pytest
    passed = num(/(\d+) passed/, m[1]) ?? 0; failed = (num(/(\d+) failed/, m[1]) ?? 0) + (num(/(\d+) errors?/, m[1]) ?? 0); skipped = num(/(\d+) skipped/, m[1]);
  } else if ((m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(text))) { // cargo
    passed = 0; failed = 0;
    for (const x of text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) { passed += Number(x[1]); failed += Number(x[2]); }
  } else if ((m = /(?:^|\n)[^\n]*\+(\d+)(?: ~(\d+))?(?: -(\d+))?: (?:All tests passed!|Some tests failed\.)/.exec(text))) { // flutter, dart
    passed = Number(m[1]); skipped = m[2] ? Number(m[2]) : null; failed = m[3] ? Number(m[3]) : 0;
  } else if (/^(ok|FAIL|---)\s/m.test(text) && /^(ok\s+\S+|FAIL\s+\S+|--- (PASS|FAIL))/m.test(text)) { // go
    const p = (text.match(/^--- PASS/gm) || []).length, f = (text.match(/^--- FAIL/gm) || []).length;
    passed = p || (text.match(/^ok\s/gm) || []).length; failed = f || (text.match(/^FAIL\s+\S+\s/gm) || []).length;
  } else if ((m = /(\d+) (?:examples?|tests?), (\d+) failures?/.exec(text))) { // rspec, minitest, phpunit-ish
    failed = Number(m[2]); passed = Number(m[1]) - failed;
  } else if ((m = /(\d+) passing/.exec(text))) { // mocha
    passed = Number(m[1]); failed = num(/(\d+) failing/, text) ?? 0; skipped = num(/(\d+) pending/, text);
  } else if ((m = /(\d+) passed/.exec(text)) || /(\d+) failed/.test(text)) {
    passed = m ? Number(m[1]) : 0; failed = num(/(\d+) failed/, text) ?? 0;
  }
  const failures = lines.filter(l => /^\s*(✕|✗|×|not ok\b|FAIL\b|FAILED\b|--- FAIL|\[FAIL\]|E\s{2,})/.test(l) || /\bFAILED\b|\[E\]/.test(l)).map(l => l.trim()).slice(0, 8);
  return { passed, failed, skipped, failures };
}

export function installSummary(lines) {
  const text = lines.join('\n');
  const m = /added \d+ packages?[^\n]*|up to date[^\n]*|Successfully installed [^\n]*|Requirement already satisfied|Changed \d+ dependenc[^\n]*|Got dependencies!?|Installed \d+ packages?[^\n]*|Resolved \d+ packages?[^\n]*|Pod installation complete![^\n]*|Bundle complete![^\n]*|Done in [\d.]+m?s[^\n]*/i.exec(text);
  const warn = (text.match(/\bvulnerabilit(y|ies)\b[^\n]*/i) || [])[0] || '';
  return { summary: (m ? m[0] : lines.filter(Boolean).pop() || '').trim().slice(0, 200), warn: /\b0 vulnerabilities/.test(warn) ? '' : warn.trim().slice(0, 160) };
}

/* What the window should show once the command has finished. */
export function interpret(view, lines, ok) {
  const L = (lines || []).filter(l => l !== '…');
  switch (view.kind) {
    case 'test': { const s = testSummary(lines || []); if (s.failed == null && s.passed == null) return s; return s; }
    case 'install': return installSummary(lines || []);
    case 'search': {
      const rows = [], files = new Set();
      for (const l of L) {
        if (!l.trim() || l === '--') continue;
        const m = /^(.+?)[:-](\d+)[:-](.*)$/.exec(l);
        if (m) { rows.push({ path: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) }); files.add(m[1]); }
        else rows.push({ path: l.trim().slice(0, 200) });
      }
      return { rows: rows.slice(0, 60), count: rows.length, files: files.size };
    }
    case 'find':
    case 'list': {
      const rows = L.map(l => l.trim()).filter(l => l && !/^total \d+$/.test(l)).map(l => ({ path: view.kind === 'list' ? l.replace(/^[bcdlps-][rwxsStT-]{9}[@+.]?\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+[\d:]+\s+/, '') : l }));
      return { rows: rows.slice(0, 80), count: rows.length };
    }
    default: return null;
  }
}
