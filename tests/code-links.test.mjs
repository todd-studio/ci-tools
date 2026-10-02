import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractFunction, extractSymbol, fingerprint, parseCodeLinkLine, readCodeLink } from '../docs-parts/code-links.mjs';

const source = `import x from 'y';

// Adds one.
// Second comment line.
export function plusOne(n) {
  return n + 1;
}

// Not attached: a blank line separates it.

const arrow = (n) => {
  return n * 2;
};

export class Box {
  open() {
    return 'open';
  }
}
`;

test('an exported function comes back with the comment directly above it', () => {
  const { text, startLine } = extractFunction(source, 'plusOne');
  assert.equal(text, '// Adds one.\n// Second comment line.\nexport function plusOne(n) {\n  return n + 1;\n}');
  assert.equal(startLine, 3);
});

test('a const arrow function is found, and a detached comment is not pulled in', () => {
  const { text } = extractFunction(source, 'arrow');
  assert.equal(text, 'const arrow = (n) => {\n  return n * 2;\n};');
});

test('a class method is found and de-indented', () => {
  assert.equal(extractFunction(source, 'Box.open').text, "open() {\n  return 'open';\n}");
});

test('a missing name is an error naming the file and the function', () => {
  assert.throws(() => extractFunction(source, 'gone', 'a.mjs'), /code link a\.mjs#gone: no function/);
});

test('a source that does not parse is an error, not an empty block', () => {
  assert.throws(() => extractFunction('function (', 'f', 'a.mjs'), /does not parse/);
});

test('the reference syntax accepts path#name and nothing looser', () => {
  assert.deepEqual(parseCodeLinkLine(' services/x/y.mjs#run '), {
    path: 'services/x/y.mjs',
    name: 'run',
    fingerprint: undefined,
  });
  assert.deepEqual(parseCodeLinkLine('scripts/x.sh#run @0123456789ab'), {
    path: 'scripts/x.sh',
    name: 'run',
    fingerprint: '0123456789ab',
  });
  assert.throws(() => parseCodeLinkLine('services/x/y.mjs:12'), /expected <repo path>/);
  assert.throws(() => parseCodeLinkLine('services/x/y.mjs#run @abc'), /expected <repo path>/);
  assert.equal(parseCodeLinkLine('web/x.tsx#run').path, 'web/x.tsx');
  assert.throws(() => parseCodeLinkLine('web/x.rb#run'), /expected <repo path>/);
});

test('shell and Python functions are located by name, and a missing one is an error', () => {
  const sh = '#!/bin/sh\nfirst() {\n  echo 1\n}\n\nfunction second {\n  echo 2\n}\n';
  assert.equal(extractSymbol(sh, 'first', 'a.sh').text, 'first() {\n  echo 1\n}');
  assert.equal(extractSymbol(sh, 'second', 'a.sh').startLine, 6);
  const py = 'def a():\n    return 1\n\nclass K:\n    def m(self):\n        return 2\n\nx = 1\n';
  assert.equal(extractSymbol(py, 'a', 'a.py').text, 'def a():\n    return 1');
  assert.equal(extractSymbol(py, 'm', 'a.py').text, '    def m(self):\n        return 2');
  assert.throws(() => extractSymbol(sh, 'third', 'a.sh'), /no shell function named third/);
  assert.throws(() => extractSymbol(py, 'zzz', 'a.py'), /no Python function named zzz/);
  assert.throws(() => extractSymbol('x', 'f', 'a.rb'), /not a JavaScript, TypeScript, shell or Python file/);
});

test('a fingerprint ignores comments and whitespace but not a changed body', () => {
  const a = fingerprint('function f() {\n  return 1; // one\n}', 'f.mjs');
  assert.equal(a, fingerprint('function f() { /* hi */ return   1; }', 'f.mjs'));
  assert.notEqual(a, fingerprint('function f() { return 2 }', 'f.mjs'));
  const b = fingerprint('f() {\n  # note\n  echo   1\n}', 'f.sh');
  assert.equal(b, fingerprint('f() {\n  echo 1\n}', 'f.sh'));
  assert.notEqual(b, fingerprint('f() {\n  echo 2\n}', 'f.sh'));
});

test('fingerprints use the expected canonical SHA-256 digest for each language', () => {
  // These literals were calculated from each language's canonical token/text form with SHA-256, not by fingerprint().
  assert.equal(fingerprint('function f() {\n  return 1;\n}', 'f.mjs'), 'd571bac8b70f');
  assert.equal(fingerprint('f() {\n  echo 1\n}', 'f.sh'), 'f5a6042efc63');
  assert.equal(fingerprint('def f():\n    return 1', 'f.py'), '8795b1c438f5');
  assert.equal(fingerprint('function f(x: number) { return x / 2; }', 'f.ts'), 'dbca27dbd1ce');
  assert.equal(fingerprint('const C = () => <div> a  b </div>;', 'f.tsx'), '652a5d94c4b0');
});

test('a reference reads the live file, and cannot leave the repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-link-'));
  try {
    fs.writeFileSync(path.join(root, 'm.mjs'), 'export function live() { return 1; }\n');
    assert.equal(readCodeLink('m.mjs#live', root).text, 'export function live() { return 1; }');
    fs.writeFileSync(path.join(root, 'm.mjs'), 'export function live() { return 2; }\n');
    assert.match(readCodeLink('m.mjs#live', root).text, /return 2/);
    assert.throws(() => readCodeLink('../outside.mjs#f', root), /escapes the repository/);
    assert.throws(() => readCodeLink('absent.mjs#f', root), /does not exist/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const TS = `// Opens it.
export async function open<T extends string>(x: T, n = 1): Promise<T> {
  return x.repeat(n) as T;
}

export const arrow = (a: number): number => a / 2;

export class Box {
  private n = 1;
  /** Returns the count. */
  count(): number {
    return this.n;
  }
}

export interface Shape { w: number }
`;

test('TypeScript functions, arrows and methods are located; types alone are not links', () => {
  const open = extractSymbol(TS, 'open', 'a.ts');
  assert.match(open.text, /^\/\/ Opens it\.\nexport async function open<T extends string>/);
  assert.equal(open.startLine, 1);
  assert.equal(extractSymbol(TS, 'arrow', 'a.ts').text, 'export const arrow = (a: number): number => a / 2;');
  assert.equal(
    extractSymbol(TS, 'Box.count', 'a.ts').text,
    '/** Returns the count. */\ncount(): number {\n  return this.n;\n}',
  );
  assert.throws(() => extractSymbol(TS, 'Shape', 'a.ts'), /no function, class or method named Shape/);
  assert.throws(() => extractSymbol('export function (', 'f', 'a.ts'), /does not parse as TypeScript/);
  assert.match(extractSymbol('export const C = () => <b>{1}</b>;\n', 'C', 'c.tsx').text, /<b>/);
});

test('a TypeScript fingerprint ignores comments and whitespace but not a changed body', () => {
  const f = (text, where = 'a.ts') => fingerprint(text, where);
  const a = f('function f(x: number) {\n  return x / 2; // half\n}');
  assert.equal(a, f('/** doc */ function f(x: number) { return   x / 2; }'));
  assert.notEqual(a, f('function f(x: number) {\n  return x / 3;\n}'));
  assert.notEqual(a, f('function f(x: string) {\n  return x / 2;\n}'), 'a changed type is a change');
  assert.notEqual(f('const r = (s: string) => /a\\/b/.test(s);'), f('const r = (s: string) => /a\\/c/.test(s);'));
  const m = extractSymbol(TS, 'Box.count', 'a.ts').text;
  assert.equal(f(m), f(m.replace('this.n', 'this.n /* same */')));
  assert.notEqual(f(m), f(m.replace('this.n', 'this.n + 1')));
});

test('a TSX fingerprint ignores JSX text reflow but not a changed word', () => {
  const f = (t) => fingerprint(t, 'c.tsx');
  assert.equal(f('const C = () => <div> a  b </div>;'), f('const C = () => <div>\n  a b\n</div>;'));
  assert.notEqual(f('const C = () => <div>a b</div>;'), f('const C = () => <div>a c</div>;'));
});
