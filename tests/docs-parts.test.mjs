import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { answer, coverage, run, stillTrueAnswers } from '../docs-parts/docs-parts.mjs';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });

// A real scratch repository: two parts, a base commit on main, a branch to change.
function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parts-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (f, c = 'x\n') => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  };
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  put(
    'docs-site/parts.json',
    JSON.stringify([
      { id: 'alpha', source: 'parts/alpha', owns: ['src/alpha/', 'bin/*.sh', '!src/alpha/gen/'] },
      { id: 'beta', source: 'parts/beta', owns: ['src/beta/'] },
    ]),
  );
  for (const f of [
    'src/alpha/a.js',
    'src/alpha/gen/g.js',
    'src/beta/b.js',
    'bin/run.sh',
    'parts/alpha/overview.md',
    'parts/beta/overview.md',
  ])
    put(f);
  put('docs-site/parts-exempt.json', '["LICENSE","docs-site/","parts/"]');
  put('LICENSE');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  git(dir, 'checkout', '-qb', 'work');
  const commit = (m = 'c') => {
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', m);
  };
  return { dir, put, commit };
}

test('coverage names a file in no part and a file in two parts', (t) => {
  const { dir, put, commit } = scratch(t);
  put('stray.txt');
  put('src/beta/gen.sh');
  put('bin/two.sh');
  // make bin/*.sh also beta's, so bin/two.sh and bin/run.sh sit in two parts
  const reg = JSON.parse(fs.readFileSync(path.join(dir, 'docs-site/parts.json'), 'utf8'));
  reg[1].owns.push('bin/two.sh');
  put('docs-site/parts.json', JSON.stringify(reg));
  commit();
  const { problems } = coverage(dir);
  assert.deepEqual(problems.sort(), [
    'bin/two.sh: in 2 parts (alpha, beta)',
    'src/alpha/gen/g.js: in no part',
    'stray.txt: in no part',
  ]);
});

test('coverage passes a clean tree, honours the exempt list and the ! exclusion', (t) => {
  const { dir } = scratch(t);
  // src/alpha/gen/ is excluded from alpha and owned by nobody: only that one is reported.
  assert.deepEqual(coverage(dir).problems, ['src/alpha/gen/g.js: in no part']);
});

test('coverage is a warning by default and an error with --strict; unreadable registry is undecided', (t) => {
  const { dir, put, commit } = scratch(t);
  put('stray.txt');
  commit();
  const out = [];
  const sink = { log: (l) => out.push(l), err: (l) => out.push(l) };
  assert.equal(run(['coverage', '--root', dir], sink), 0);
  assert.equal(run(['coverage', '--root', dir, '--strict'], sink), 1);
  put('docs-site/parts.json', '{not json');
  commit();
  assert.equal(run(['coverage', '--root', dir, '--strict'], sink), 2);
});

test('a code change with no page change and no answer is unanswered, naming the part', (t) => {
  const { dir, put, commit } = scratch(t);
  put('src/alpha/a.js', 'changed\n');
  commit();
  const r = answer(dir, { base: 'main', body: '## What & why\nstuff' });
  assert.deepEqual(r.unanswered, ['alpha']);
  assert.deepEqual(
    r.touched.map((p) => p.id),
    ['alpha'],
  );
});

test('changing the part pages answers it; so does a Docs: still true line', (t) => {
  const { dir, put, commit } = scratch(t);
  put('src/alpha/a.js', 'changed\n');
  put('src/beta/b.js', 'changed\n');
  put('parts/alpha/overview.md', 'edited\n');
  commit();
  assert.deepEqual(answer(dir, { base: 'main', body: '' }).unanswered, ['beta']);
  const body = 'Docs: beta still true — only a typo fix in a comment\n';
  assert.deepEqual(answer(dir, { base: 'main', body }).unanswered, []);
});

test('a still-true answer needs a reason and the right part', (t) => {
  const { dir, put, commit } = scratch(t);
  put('src/beta/b.js', 'changed\n');
  commit();
  for (const body of ['Docs: beta still true', 'Docs: beta still true — ', 'Docs: alpha still true — wrong part'])
    assert.deepEqual(answer(dir, { base: 'main', body }).unanswered, ['beta'], body);
  assert.deepEqual(
    [...stillTrueAnswers('- Docs: beta still true -- why\nDocs: alpha still true - ok').keys()],
    ['beta', 'alpha'],
  );
});

test('docs-only, markdown-only and exempt changes need no answer', (t) => {
  const { dir, put, commit } = scratch(t);
  put('parts/beta/overview.md', 'edited\n');
  put('notes.md', 'hi\n');
  put('LICENSE', 'changed\n');
  commit();
  assert.deepEqual(answer(dir, { base: 'main', body: '' }).touched, []);
});

test('answer exits 1 on an unanswered part and 2 when the base cannot be read', (t) => {
  const { dir, put, commit } = scratch(t);
  put('src/beta/b.js', 'changed\n');
  commit();
  const sink = { log: () => {}, err: () => {} };
  t.after(() => delete process.env.DOCS_PARTS_TEST_BODY);
  process.env.DOCS_PARTS_TEST_BODY = '';
  assert.equal(run(['answer', '--root', dir, '--base', 'main', '--body-env', 'DOCS_PARTS_TEST_BODY'], sink), 1);
  assert.equal(run(['answer', '--root', dir, '--base', 'no-such-ref', '--body-env', 'DOCS_PARTS_TEST_BODY'], sink), 2);
  process.env.DOCS_PARTS_TEST_BODY = 'Docs: beta still true — comment only';
  assert.equal(run(['answer', '--root', dir, '--base', 'main', '--body-env', 'DOCS_PARTS_TEST_BODY'], sink), 0);
});

// ---- code-link fingerprints (WS #2724) --------------------------------------------------------

import { boundaries, codeLinkLines, links, refresh, runAsync } from '../docs-parts/docs-parts.mjs';

const JS = 'export function one() {\n  return 1;\n}\n\nexport function two() {\n  return 2;\n}\n';
const SH = '#!/bin/sh\nhello() {\n  echo hi\n}\n\nother() {\n  echo there\n}\n';
const PY = 'def greet():\n    return 1\n\ndef other():\n    return 2\n';
const page = (...refs) => `---\ntitle: p\n---\n\nThe paragraph.\n\n\`\`\`code-link\n${refs.join('\n')}\n\`\`\`\n`;

function linkRepo(t) {
  const s = scratch(t);
  s.put('src/alpha/a.js', JS);
  s.put('bin/run.sh', SH);
  s.put('src/alpha/tool.py', PY);
  s.put('parts/alpha/how.md', page('src/alpha/a.js#one', 'bin/run.sh#hello', 'src/alpha/tool.py#greet'));
  s.commit();
  return s;
}

test('a link with no fingerprint is red, refresh stamps all three languages, then it is green', async (t) => {
  const { dir } = linkRepo(t);
  assert.match((await links(dir)).problems[0], /how\.md:8 .*no fingerprint/);
  assert.equal((await refresh(dir, ['parts/alpha/how.md'])).length, 3);
  assert.deepEqual((await links(dir)).problems, []);
});

test('a changed body fires and names the paragraph; reformatting, comments and other functions do not', async (t) => {
  const { dir, put, commit } = linkRepo(t);
  await refresh(dir, ['parts/alpha/how.md']);
  commit();
  put('src/alpha/a.js', JS.replace('return 2', 'return 22') + '// trailing comment\n');
  put('bin/run.sh', SH.replace('echo there', 'echo elsewhere  # not the linked function'));
  put('src/alpha/tool.py', PY.replace('return 2', 'return 3') + '\n\n');
  commit();
  assert.deepEqual((await links(dir)).problems, [], 'edits to other functions in the file are not the link');
  put(
    'src/alpha/a.js',
    'export function one() {\n    return   1 /* same */ ;\n}\n\nexport function two() {\n  return 2;\n}\n',
  );
  assert.deepEqual((await links(dir)).problems, [], 'whitespace and comments do not change the fingerprint');
  put('src/alpha/a.js', JS.replace('return 1', 'return 100'));
  put('bin/run.sh', SH.replace('echo hi', 'echo bye'));
  put('src/alpha/tool.py', PY.replace('return 1', 'return 9'));
  const { problems } = await links(dir);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /how\.md:8 \(paragraph at line 5\).*src\/alpha\/a\.js#one changed since/);
  await refresh(dir, ['parts/alpha/how.md']);
  assert.deepEqual((await links(dir)).problems, []);
});

test('a link that cannot be located is red, and an unclosed fence is undecided, never green', async (t) => {
  const { dir, put, commit } = linkRepo(t);
  await refresh(dir, ['parts/alpha/how.md']);
  put('src/alpha/a.js', 'export const x = 1;\n');
  commit();
  assert.match((await links(dir)).problems[0], /no function, class or method named one/);
  put('parts/alpha/how.md', '```code-link\nsrc/alpha/a.js#x\n');
  commit();
  const err = [];
  assert.equal(await runAsync(['links', '--root', dir], { err: (m) => err.push(m), log() {} }), 2);
  assert.match(err.join(), /never closed/);
});

// ---- boundary rules and the crossings ratchet (WS #2724) --------------------------------------

function boundaryRepo(t, crossings = []) {
  const s = scratch(t);
  s.put('src/alpha/a.js', "import './b.js';\n");
  s.put('src/alpha/b.js', 'export const b = 1;\n');
  s.put('src/beta/b.js', 'export const beta = 1;\n');
  s.put('bin/run.sh', 'echo hi\n# alpha.db mentioned only in a comment\n');
  s.put(
    'parts/alpha/contract.md',
    '# contract\nsrc/alpha/unlisted.js is named before the table.\n\n**Known boundary crossings**\n\nbin/run.sh and src/alpha/a.js.\n',
  );
  s.put(
    'docs-site/boundaries.json',
    JSON.stringify({
      parts: {
        alpha: {
          rules: [
            {
              id: 'no-beta',
              kind: 'import',
              text: 'alpha does not import beta',
              from: ['src/alpha/'],
              forbid: ['src/beta/'],
            },
            { id: 'no-db', kind: 'reference', text: 'only alpha names its db', in: ['bin/'], pattern: 'alpha\\.db' },
          ],
          crossings,
        },
      },
    }),
  );
  s.commit();
  return s;
}
const cross = (rule, file, target) => ({ rule, file, target, why: 'because', issue: '#1' });

test('a new import crossing and a new reference crossing are red, a comment mention is not', async (t) => {
  const { dir, put, commit } = boundaryRepo(t);
  assert.deepEqual((await boundaries(dir)).problems, []);
  put('src/alpha/a.js', "import './b.js';\nimport '../beta/b.js';\n");
  put('bin/run.sh', 'sqlite3 alpha.db\n');
  commit();
  const { problems } = await boundaries(dir);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /NEW crossing src\/alpha\/a\.js → src\/beta\/b\.js/);
  assert.match(problems.join('\n'), /NEW crossing bin\/run\.sh → alpha\.db/);
});

test('a baselined crossing passes, and the ratchet turns red once it is gone', async (t) => {
  const { dir, put, commit } = boundaryRepo(t, [cross('no-beta', 'src/alpha/a.js', 'src/beta/b.js')]);
  assert.match((await boundaries(dir)).problems.join(), /no longer occurs — remove it from the baseline/);
  put('src/alpha/a.js', "import '../beta/b.js';\n");
  commit();
  assert.deepEqual((await boundaries(dir)).problems, []);
});

test('a baseline entry must be in the contract, name a real rule, and carry a why and an issue', async (t) => {
  const bad = { rule: 'nope', file: 'src/unlisted.js', target: 'x' };
  const { dir, put, commit } = boundaryRepo(t, [bad]);
  put('src/unlisted.js', 'x\n');
  commit();
  const text = (await boundaries(dir)).problems.join('\n');
  assert.match(text, /unknown rule nope/);
  assert.match(text, /not listed under "Known boundary crossings"/);
  assert.match(text, /needs a why and an issue/);
});

test('a rule that matches no file is red, and an unreadable boundaries file is undecided', async (t) => {
  const { dir, put, commit } = boundaryRepo(t);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'docs-site/boundaries.json'), 'utf8'));
  doc.parts.alpha.rules[1].in = ['nowhere/'];
  put('docs-site/boundaries.json', JSON.stringify(doc));
  commit();
  assert.match((await boundaries(dir)).problems.join(), /matches no file, so it checks nothing/);
  put('docs-site/boundaries.json', '{ not json');
  commit();
  const err = [];
  assert.equal(await runAsync(['boundaries', '--root', dir], { err: (m) => err.push(m), log() {} }), 2);
  assert.match(err.join(), /boundaries\.json is unreadable/);
});

test('a code-link example inside a longer fence is an example, not a link', () => {
  const md = '````markdown\n```code-link\nsrc/x.js#nope\n```\n````\n\n```code-link\nsrc/y.js#yes\n```\n';
  assert.deepEqual(
    codeLinkLines('p.md', md).map((r) => r.text),
    ['src/y.js#yes'],
  );
});

test('a TypeScript import rule reads imports, exports, require and dynamic import', async (t) => {
  const { dir, put, commit } = boundaryRepo(t);
  put(
    'src/alpha/c.ts',
    "import type { X } from '../beta/x';\nexport { y } from '../beta/y';\nconst z = import('../beta/z');\nconst w: import('../beta/w').W = require('../beta/v');\nimport q = require('../beta/q');\n// import '../beta/comment'\n",
  );
  commit();
  const found = (await boundaries(dir)).problems.join('\n');
  for (const n of ['x', 'y', 'z', 'w', 'v', 'q'])
    assert.match(found, new RegExp(`src/alpha/c\\.ts → src/beta/${n}\\b`));
  assert.doesNotMatch(found, /comment|is TypeScript/);
  put('src/alpha/c.ts', 'export function broken( {\n');
  commit();
  const err = [];
  assert.equal(await runAsync(['boundaries', '--root', dir], { err: (m) => err.push(m), log() {} }), 2);
  assert.match(err.join(), /c\.ts does not parse as TypeScript/);
});

test('a missing boundaries file is undecided', async (t) => {
  const { dir } = boundaryRepo(t);
  fs.rmSync(path.join(dir, 'docs-site/boundaries.json'));
  const err = [];
  assert.equal(await runAsync(['boundaries', '--root', dir], { err: (m) => err.push(m), log() {} }), 2);
  assert.match(err.join(), /does not — a missing rules file/);
});

test('a changed regex, a multi-line Python signature and a re-indented Python line all fire', async (t) => {
  const { dir, put, commit } = linkRepo(t);
  put('src/alpha/a.js', 'export function one() {\n  return /a+/.test(x);\n}\n');
  put('src/alpha/tool.py', 'def greet(\n    a,\n):\n    if a:\n        return 1\n    return 2\n');
  put('parts/alpha/how.md', page('src/alpha/a.js#one', 'src/alpha/tool.py#greet'));
  commit();
  await refresh(dir, ['parts/alpha/how.md']);
  assert.deepEqual((await links(dir)).problems, []);
  put('src/alpha/a.js', 'export function one() {\n  return /b*/.test(x);\n}\n');
  put('src/alpha/tool.py', 'def greet(\n    a,\n):\n    if a:\n        return 1\n        return 2\n');
  assert.equal((await links(dir)).problems.length, 2);
  put('src/alpha/a.js', 'export function one() {\n  return /a+/.test(x);\n}\n');
  put('src/alpha/tool.py', 'def greet(\n    a,\n):\n    if a:\n        return 1\n    return 3\n');
  assert.match(
    (await links(dir)).problems.join('\n'),
    /tool\.py#greet changed/,
    'the body after the signature is covered',
  );
});

test('refresh stamps nothing when one link in the batch cannot be located', async (t) => {
  const { dir, put, commit } = linkRepo(t);
  put('parts/alpha/bad.md', page('src/alpha/a.js#missing'));
  commit();
  const before = fs.readFileSync(path.join(dir, 'parts/alpha/how.md'), 'utf8');
  const err = [];
  const code = await runAsync(['refresh', '--root', dir, 'parts/alpha/how.md', 'parts/alpha/bad.md'], {
    err: (m) => err.push(m),
    log() {},
  });
  assert.equal(code, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'parts/alpha/how.md'), 'utf8'), before);
});

test('every use of a forbidden target on a line is found, and require() is an import', async (t) => {
  const { dir, put, commit } = boundaryRepo(t);
  put('src/alpha/a.js', "const x = require('../beta/b.js');\n");
  put('bin/run.sh', 'cp alpha.db alpha.db.bak\n');
  commit();
  const text = (await boundaries(dir)).problems.join('\n');
  assert.match(text, /src\/alpha\/a\.js → src\/beta\/b\.js/);
  assert.match(text, /bin\/run\.sh → alpha\.db\b/);
});

test('a TypeScript link is stamped, then fires when its body changes', async (t) => {
  const TS = 'export function one(n: number): number {\n  return n + 1;\n}\n';
  const { dir, put, commit } = linkRepo(t);
  put('src/alpha/t.ts', TS);
  put('parts/alpha/ts.md', page('src/alpha/t.ts#one'));
  commit();
  await refresh(dir, ['parts/alpha/how.md']);
  assert.match((await links(dir)).problems.join(), /t\.ts#one has no fingerprint/);
  await refresh(dir, ['parts/alpha/ts.md']);
  assert.deepEqual((await links(dir)).problems, []);
  put('src/alpha/t.ts', TS.replace('n + 1', 'n + 2'));
  assert.match((await links(dir)).problems.join(), /t\.ts#one changed since/);
});

test('--require-registry turns a missing registry or wrong --root into exit 2; without it, still exit 0', async (t) => {
  const { dir } = scratch(t);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parts-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  git(empty, 'init', '-q');
  const quiet = { log() {}, err() {} };
  const { runAsync } = await import('../docs-parts/docs-parts.mjs');
  const calls = (root) => [
    ['coverage', '--root', root],
    ['answer', '--root', root, '--base', 'main', '--body-env', 'PATH'],
    ['links', '--root', root],
    ['boundaries', '--root', root],
  ];
  for (const argv of calls(empty)) {
    const bad = [];
    assert.equal(await runAsync([...argv, '--require-registry'], { ...quiet, err: (m) => bad.push(m) }), 2, argv[0]);
    assert.match(bad.join('\n'), /cannot decide.*docs-site\/parts\.json/, argv[0]);
  }
  for (const argv of calls(path.join(empty, 'nope'))) {
    assert.equal(await runAsync([...argv, '--require-registry'], quiet), 2, `${argv[0]} wrong root`);
  }
  // Backward compatible: without the flag a missing registry is still "not opted in".
  assert.equal(await runAsync(['coverage', '--root', empty], quiet), 0);
  assert.equal(await runAsync(['links', '--root', empty], quiet), 0);
  // With a registry present the flag changes nothing.
  assert.equal(await runAsync(['coverage', '--root', dir, '--require-registry'], quiet), 0);
});
