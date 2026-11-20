import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, tokenize, testSummary, installSummary, interpret } from '../src/shell.js';

const kind = c => { const v = classify(c); return v ? v.kind : null; };

test('file reads go to the Editor', () => {
  assert.deepEqual(classify('cat src/a.ts'), { kind: 'read', path: 'src/a.ts', start: 1 });
  assert.deepEqual(classify("sed -n '10,40p' lib/main.dart"), { kind: 'read', path: 'lib/main.dart', start: 10, end: 40 });
  assert.deepEqual(classify('sed -n 5p a.txt'), { kind: 'read', path: 'a.txt', start: 5, end: 5 });
  assert.deepEqual(classify('head -n 20 README.md'), { kind: 'read', path: 'README.md', start: 1 });
  assert.equal(classify('tail -50 app.log').start, null, 'tail: line numbers unknown');
  assert.equal(classify('cat a.ts | head -5').start, null);
  assert.deepEqual(classify('cd /w/app && cat "my file.txt" 2>/dev/null'), { kind: 'read', path: 'my file.txt', start: 1, cwd: '/w/app' });
  assert.equal(kind('cat a.ts b.ts'), null, 'two files: not one window');
  assert.equal(kind('tail -f app.log'), null);
});

test('sed -i goes to the Editor as an edit, with the rule', () => {
  assert.deepEqual(classify("sed -i '' 's/foo/bar/g' src/a.ts"), { kind: 'edit', path: 'src/a.ts', rule: 's/foo/bar/g', old: 'foo', new: 'bar' });
  assert.deepEqual(classify('sed -i "s|http://a|https://b|" conf.yml'), { kind: 'edit', path: 'conf.yml', rule: 's|http://a|https://b|', old: 'http://a', new: 'https://b' });
  assert.deepEqual(classify("sed -i.bak -e '3d' notes.txt"), { kind: 'edit', path: 'notes.txt', rule: '3d' });
  assert.equal(kind("sed 's/a/b/' file.txt"), null, 'prints to the screen, changes nothing');
});

test('searching and listing go to Files', () => {
  assert.deepEqual(classify('grep -rn "useTheme" src --include=*.ts'), { kind: 'search', pattern: 'useTheme', path: 'src' });
  assert.deepEqual(classify("rg -t ts -e 'foo|bar' lib test"), { kind: 'search', pattern: 'foo|bar', path: 'lib test' });
  assert.deepEqual(classify('grep -A 3 TODO a.ts | head -20'), { kind: 'search', pattern: 'TODO', path: 'a.ts' });
  assert.deepEqual(classify("find . -name '*.dart' -type f"), { kind: 'find', pattern: '*.dart', path: '.' });
  assert.deepEqual(classify('ls -la src'), { kind: 'list', path: 'src' });
  assert.equal(kind('find . -name "*.tmp" -delete'), null, 'this one changes things');
  assert.equal(kind('find . -name x -exec rm {} \\;'), null);
});

test('curl goes to Web, git to Git', () => {
  assert.deepEqual(classify('curl -s https://api.example.com/health'), { kind: 'web', url: 'https://api.example.com/health', method: 'GET' });
  assert.equal(classify("curl -X POST https://x.dev/api -d '{}'").method, 'POST');
  assert.deepEqual(classify('git status --short'), { kind: 'git', subs: ['status'] });
  assert.deepEqual(classify('git -C /w/app diff HEAD~1'), { kind: 'git', subs: ['diff'] });
  assert.deepEqual(classify('git add -A && git commit -q -m "Fix: a && b; c"'), { kind: 'git', subs: ['add', 'commit'] });
  assert.deepEqual(classify('cd repo && git log --oneline | head -5'), { kind: 'git', subs: ['log'], cwd: 'repo' });
});

test('test runs and installs get their own windows', () => {
  for (const c of ['npm test', 'npm run test:unit', 'npm test -- settings', 'npx vitest run', 'pytest -q tests/', 'python -m pytest', 'go test ./...', 'cargo test', 'flutter test', 'node --test test/*.test.js', 'CI=1 yarn test', 'bundle exec rspec'])
    assert.equal(kind(c), 'test', c);
  assert.deepEqual(classify('npm install express zod --save'), { kind: 'install', manager: 'npm', packages: ['express', 'zod'] });
  assert.deepEqual(classify('pip install -r requirements.txt'), { kind: 'install', manager: 'pip', packages: [] });
  assert.equal(classify('flutter pub get').manager, 'flutter pub');
  assert.equal(kind('npm run build'), null);
  assert.equal(kind('npm run dev'), null);
});

test('anything unclear stays in the Shell', () => {
  for (const c of [
    'cat a.ts | grep foo',            // piped into another tool
    'cat a.ts > b.ts',                // writes a file
    'echo hi >> log.txt',
    'cat $(ls | head -1)',            // substitution
    'cat `which node`',
    'grep foo a.ts && rm a.ts',       // chained with something else
    'npm test || echo failed',
    'npm test & ',
    'node script.js', 'make', 'rm -rf build', 'docker ps', '', '   ',
    'cat "unclosed',
    'diff <(sort a) <(sort b)',
  ]) assert.equal(kind(c), null, JSON.stringify(c));
  for (const junk of [null, undefined, 5, {}, 'x'.repeat(5000)]) assert.equal(classify(junk), null);
});

test('tokenizer: quotes, escapes and harmless redirects', () => {
  const words = c => tokenize(c).map(t => t.op ? '<' + t.op + '>' : t.v);
  assert.deepEqual(words(`git commit -m "a && b" 2>&1`), ['git', 'commit', '-m', 'a && b']);
  assert.deepEqual(words(`sed -i '' 's/a b/c/' f\\ g.txt`), ['sed', '-i', '', 's/a b/c/', 'f g.txt']);
  assert.deepEqual(words('a >/dev/null 2>&1 | b'), ['a', '<|>', 'b']);
  assert.deepEqual(words('a &>/dev/null; b'), ['a', '<;>', 'b']);
  assert.deepEqual(words('a > out.txt'), ['a', '<>>', 'out.txt']);
  assert.deepEqual(words('echo 2 >x'), ['echo', '2', '<>>', 'x']);
});

test('reads test results from many runners', () => {
  const s = t => { const r = testSummary(t.split('\n')); return [r.passed, r.failed]; };
  assert.deepEqual(s('Tests:       1 failed, 4 passed, 5 total'), [4, 1]);
  assert.deepEqual(s('Tests:       12 passed, 12 total'), [12, 0]);
  assert.deepEqual(s(' Test Files  1 failed | 2 passed (3)\n      Tests  2 failed | 9 passed (11)'), [9, 2]);
  assert.deepEqual(s('# tests 20\n# pass 19\n# fail 1'), [19, 1]);
  assert.deepEqual(s('===== 3 passed, 1 failed, 2 skipped in 0.42s ====='), [3, 1]);
  assert.deepEqual(s('========================= 7 passed in 1.20s ========================='), [7, 0]);
  assert.deepEqual(s('test result: ok. 5 passed; 0 failed; 0 ignored\ntest result: FAILED. 2 passed; 1 failed;'), [7, 1]);
  assert.deepEqual(s('00:04 +12: All tests passed!'), [12, 0]);
  assert.deepEqual(s('00:09 +10 ~1 -2: Some tests failed.'), [10, 2]);
  assert.deepEqual(s('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)\nFAIL\tpkg/x\t0.2s'), [1, 1]);
  assert.deepEqual(s('ok  \tpkg/a\t0.1s\nok  \tpkg/b\t0.2s'), [2, 0]);
  assert.deepEqual(s('  8 passing (40ms)\n  1 failing'), [8, 1]);
  assert.deepEqual(s('14 examples, 2 failures'), [12, 2]);
  assert.deepEqual(s('compiling…\nsomething unrelated'), [null, null]);
  assert.deepEqual(testSummary([' FAIL  src/a.test.ts', '  ✕ renders the toggle', '  ✓ ok one']).failures, ['FAIL  src/a.test.ts', '✕ renders the toggle']);
});

test('reads install results and search output', () => {
  assert.equal(installSummary(['', 'added 12 packages, and audited 340 packages in 3s', '', 'found 0 vulnerabilities']).summary, 'added 12 packages, and audited 340 packages in 3s');
  assert.equal(installSummary(['added 1 package in 1s', '3 high severity vulnerabilities']).warn, 'vulnerabilities');
  assert.equal(installSummary(['Successfully installed requests-2.32.0']).summary, 'Successfully installed requests-2.32.0');
  const r = interpret({ kind: 'search' }, ['src/a.ts:12:  const t = useTheme();', 'src/b.ts:3:import { useTheme }', '--', 'README.md'], true);
  assert.equal(r.count, 3);
  assert.equal(r.files, 2);
  assert.deepEqual(r.rows[0], { path: 'src/a.ts', line: 12, text: 'const t = useTheme();' });
  const l = interpret({ kind: 'list' }, ['total 16', 'drwxr-xr-x  5 me  staff  160 Nov 20 14:01 src', '-rw-r--r--  1 me  staff  663 Nov 20 14:01 package.json'], true);
  assert.deepEqual(l.rows.map(x => x.path), ['src', 'package.json']);
});
