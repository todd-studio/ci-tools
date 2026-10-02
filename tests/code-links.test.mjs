import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractFunction, extractSymbol, fingerprint, parseCodeLinkLine } from '../docs-parts/code-links.mjs';
import { readCodeLink } from '../docs-parts/remark-code-links.mjs';

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
  assert.throws(() => parseCodeLinkLine('web/x.ts#run'), /expected <repo path>/);
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
  assert.throws(() => extractSymbol('x', 'f', 'a.ts'), /not a JavaScript, shell or Python file/);
});

test('a fingerprint ignores comments and whitespace but not a changed body', () => {
  const a = fingerprint('function f() {\n  return 1; // one\n}', 'f.mjs');
  assert.equal(a, fingerprint('function f() { /* hi */ return   1; }', 'f.mjs'));
  assert.notEqual(a, fingerprint('function f() { return 2 }', 'f.mjs'));
  const b = fingerprint('f() {\n  # note\n  echo   1\n}', 'f.sh');
  assert.equal(b, fingerprint('f() {\n  echo 1\n}', 'f.sh'));
  assert.notEqual(b, fingerprint('f() {\n  echo 2\n}', 'f.sh'));
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
