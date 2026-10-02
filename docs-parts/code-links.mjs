// Code links: a page names a function by path and name, never by line, and the site shows that
// function's current source inline. This module is the pure lookup (parse a JavaScript module,
// return one named function's source); lib/remark-code-links.mjs wires it into the build.
//
// A name is a top-level function, class, or `const name = <function|arrow>`, or `Class.method`.
// A name that cannot be found is an error, never an empty block: a broken link must fail the
// build rather than render a page that quietly shows nothing.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse, tokenizer } from 'acorn';

// TypeScript is read with the compiler's own parser, loaded only when a TypeScript file is linked so a
// docs site built without its dev dependencies still reads JavaScript, shell and Python.
// A failed load is left unset: a TypeScript link then fails with the message below, never passes.
const tsModule = await import('typescript').then((m) => m.default).catch(() => undefined);
function requireTypeScript(where) {
  if (!tsModule)
    throw new Error(`code link ${where}: cannot load typescript for a TypeScript file — run npm ci in the docs-parts directory`);
  return tsModule;
}

function declaredName(node) {
  if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') return node.id?.name;
  if (node.type === 'VariableDeclaration' && node.declarations.length === 1) {
    const [declaration] = node.declarations;
    const init = declaration.init;
    const isFunction = init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression');
    if (isFunction && declaration.id.type === 'Identifier') return declaration.id.name;
  }
  return undefined;
}

function methodNamed(classNode, methodName) {
  return classNode.body.body.find(
    (member) => member.type === 'MethodDefinition' && !member.computed && member.key.name === methodName,
  );
}

function findTarget(program, name) {
  const [owner, method] = name.split('.');
  for (const statement of program.body) {
    const node =
      statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement;
    if (declaredName(node) !== owner) continue;
    if (method === undefined) return { node: statement };
    if (node.type !== 'ClassDeclaration') continue;
    const found = methodNamed(node, method);
    if (found) return { node: found };
  }
  return undefined;
}

// Leading comments that sit directly above the function (no blank line between) explain it, so
// they travel with it.
function withLeadingComments(source, comments, nodeStart) {
  let start = nodeStart;
  let line = lineOf(source, start);
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment.end > start) continue;
    if (lineOf(source, comment.end) !== line - 1 && lineOf(source, comment.end) !== line) break;
    start = comment.start;
    line = lineOf(source, start);
  }
  return start;
}

function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

export function extractFunction(source, name, where = 'source') {
  const comments = [];
  let program;
  try {
    program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', onComment: comments });
  } catch (error) {
    throw new Error(`code link ${where}#${name}: ${where} does not parse as a JavaScript module (${error.message})`);
  }
  const target = findTarget(program, name);
  if (!target) throw new Error(`code link ${where}#${name}: no function, class or method named ${name} in ${where}`);
  return excerpt(source, comments, target.node.start, target.node.end);
}

// The source of one node, with the comments directly above it, flush-left.
function excerpt(source, comments, nodeStart, nodeEnd) {
  const start = withLeadingComments(source, comments, nodeStart);
  const startLine = lineOf(source, start);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const indent = source.slice(lineStart, start).match(/^\s*/)[0];
  const body = source.slice(start, nodeEnd);
  // A method is indented inside its class; strip that so the excerpt reads flush-left.
  const text = indent
    ? body
        .split('\n')
        .map((l, i) => (i === 0 ? l : l.startsWith(indent) ? l.slice(indent.length) : l))
        .join('\n')
    : body;
  return { text, startLine };
}

const JS_EXT = /\.(?:mjs|js|cjs)$/;
const TS_EXT = /\.(?:ts|tsx|mts|cts)$/;
export const isTypeScript = (where) => TS_EXT.test(where);
const SHELL_EXT = /\.sh$/;
const PYTHON_EXT = /\.py$/;
const escapeRe = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Shell: `name() {` or `function name {` at column 0, down to the first column-0 `}`.
function extractShellFunction(source, name, where) {
  const lines = source.split('\n');
  const head = new RegExp(`^(?:function\\s+${escapeRe(name)}\\b|${escapeRe(name)}\\s*\\(\\s*\\))`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Error(`code link ${where}#${name}: no shell function named ${name} in ${where}`);
  const end = lines.findIndex((l, i) => i >= start && l === '}');
  if (end < 0) throw new Error(`code link ${where}#${name}: shell function ${name} has no closing } at column 0`);
  return { text: lines.slice(start, end + 1).join('\n'), startLine: start + 1 };
}

// Python: `def name` (or `async def`), down to the next non-blank line indented no deeper than it.
function extractPythonFunction(source, name, where) {
  const lines = source.split('\n');
  const head = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+${escapeRe(name)}\\s*\\(`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) throw new Error(`code link ${where}#${name}: no Python function named ${name} in ${where}`);
  const indent = head.exec(lines[start])[1].length;
  // A signature may span lines: its body starts after the line where the brackets balance again.
  let depth = 0;
  let sigEnd = start;
  for (let i = start; i < lines.length; i += 1) {
    for (const ch of lines[i]) depth += '([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0;
    sigEnd = i;
    if (depth <= 0) break;
  }
  let end = sigEnd;
  for (let i = sigEnd + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '') continue;
    if (lines[i].match(/^\s*/)[0].length <= indent) break;
    end = i;
  }
  return { text: lines.slice(start, end + 1).join('\n'), startLine: start + 1 };
}

// TypeScript: the same names as JavaScript (function, class, `const name = <function|arrow>`,
// `Class.method`), found on the compiler's syntax tree. Overload signatures have no body and are skipped.
export function parseTypeScript(source, where, setParentNodes = false) {
  const ts = requireTypeScript(where);
  const kind = where.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(where, source, ts.ScriptTarget.Latest, setParentNodes, kind);
  // parseDiagnostics is the compiler's own list of syntax errors; if a release drops it, fail rather than pass.
  if (!Array.isArray(file.parseDiagnostics))
    throw new Error(`code link ${where}: this typescript cannot report syntax errors`);
  return { ts, file };
}

function tsDeclaredName(ts, node) {
  if (ts.isFunctionDeclaration(node)) return node.body ? node.name?.text : undefined;
  if (ts.isClassDeclaration(node)) return node.name?.text;
  if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
    const [declaration] = node.declarationList.declarations;
    const init = declaration.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && ts.isIdentifier(declaration.name))
      return declaration.name.text;
  }
  return undefined;
}

function extractTypeScriptSymbol(source, name, where) {
  const { ts, file } = parseTypeScript(source, where);
  if (file.parseDiagnostics.length > 0)
    throw new Error(
      `code link ${where}#${name}: ${where} does not parse as TypeScript (${ts.flattenDiagnosticMessageText(file.parseDiagnostics[0].messageText, ' ')})`,
    );
  const [owner, method] = name.split('.');
  let target;
  for (const statement of file.statements) {
    if (tsDeclaredName(ts, statement) !== owner) continue;
    if (method === undefined) {
      target = statement;
      break;
    }
    if (!ts.isClassDeclaration(statement)) continue;
    target = statement.members.find(
      (m) => ts.isMethodDeclaration(m) && m.body && !ts.isComputedPropertyName(m.name) && m.name.text === method,
    );
    if (target) break;
  }
  if (!target) throw new Error(`code link ${where}#${name}: no function, class or method named ${name} in ${where}`);
  const comments = (ts.getLeadingCommentRanges(source, target.getFullStart()) ?? []).map((c) => ({
    start: c.pos,
    end: c.end,
  }));
  return excerpt(source, comments, target.getStart(file), target.end);
}

// The compiler's leaf tokens with comments left out. A method excerpt is not a statement, so a text that
// does not parse alone is parsed inside a class; the same text always takes the same path.
function typeScriptTokens(text, where) {
  const attempt = (code) => {
    const { ts, file } = parseTypeScript(code, where);
    if (file.parseDiagnostics.length > 0) return undefined;
    const tokens = [];
    const walk = (node) => {
      if (ts.isJSDoc(node)) return;
      const children = node.getChildren(file);
      // JSX text is whitespace-insensitive to the renderer, so a reflow is not a change.
      if (node.kind === ts.SyntaxKind.JsxText) {
        const words = node.getText(file).trim().replace(/\s+/g, ' ');
        if (words) tokens.push(`${node.kind}:${words}`);
      } else if (children.length === 0) tokens.push(`${node.kind}:${node.getText(file)}`);
      else children.forEach(walk);
    };
    walk(file);
    return tokens;
  };
  const tokens = attempt(text) ?? attempt(`class _ {\n${text}\n}`);
  if (!tokens) throw new Error(`code link ${where}: the linked text does not parse as TypeScript`);
  return tokens;
}

// The one place a language is chosen. An unknown language is refused rather than guessed at: a link that
// cannot be located must fail, never render or fingerprint nothing.
export function extractSymbol(source, name, where = 'source') {
  if (JS_EXT.test(where)) return extractFunction(source, name, where);
  if (TS_EXT.test(where)) return extractTypeScriptSymbol(source, name, where);
  if (SHELL_EXT.test(where)) return extractShellFunction(source, name, where);
  if (PYTHON_EXT.test(where)) return extractPythonFunction(source, name, where);
  throw new Error(`code link ${where}#${name}: ${where} is not a JavaScript, TypeScript, shell or Python file`);
}

// A fingerprint of a function's body that ignores comments and whitespace, so reformatting or
// re-commenting does not fire it and an edit elsewhere in the file cannot reach it. JavaScript is
// hashed as acorn tokens (TypeScript as the compiler's); shell and Python drop whole-line comments and collapse whitespace.
export function fingerprint(text, where = 'source') {
  let canonical;
  if (JS_EXT.test(where)) {
    const tokens = [];
    for (const token of tokenizer(text, { ecmaVersion: 'latest', sourceType: 'module' })) {
      // A regular expression token's value is an object; without this, every regex hashes alike.
      const v = token.value;
      const value = v && typeof v === 'object' && 'pattern' in v ? `/${v.pattern}/${v.flags}` : String(v ?? '');
      tokens.push(`${token.type.label}:${value}`);
    }
    canonical = tokens.join('\n');
  } else if (TS_EXT.test(where)) {
    canonical = typeScriptTokens(text, where).join('\n');
  } else {
    const code = text.split('\n').filter((l) => !/^\s*#/.test(l));
    // Indentation is meaning in Python, so it stays (relative to the least-indented line); in shell it is not.
    const floor = Math.min(...code.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    canonical = code
      .filter((l) => l.trim())
      .map(
        (l) =>
          (PYTHON_EXT.test(where) ? ' '.repeat(l.match(/^\s*/)[0].length - floor) : '') + l.trim().replace(/\s+/g, ' '),
      )
      .join('\n');
  }
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

// One `path#name` reference, as written on a line of a ```code-link fence, with the fingerprint
// recorded after it: `path#name @0123456789ab`. The fingerprint is optional to parse (the site
// renders without it); `docs-parts.mjs links` is what insists on it.
export function parseCodeLinkLine(line) {
  const match =
    /^([^\s#]+\.(?:mjs|js|cjs|ts|tsx|mts|cts|sh|py))#([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?)(?:\s+@([0-9a-f]{12}))?$/.exec(
      line.trim(),
    );
  if (!match) {
    throw new Error(
      `code link "${line.trim()}": expected <repo path>.(mjs|js|cjs|ts|tsx|mts|cts|sh|py)#<function name> [@<12 hex fingerprint>]`,
    );
  }
  return { path: match[1], name: match[2], fingerprint: match[3] };
}

// Read one `path#name @<fingerprint>` line against the checkout at `root`: the symbol's current source and
// fingerprint beside the recorded one. A path that leaves the checkout or does not exist is an error.
export function readCodeLink(line, root) {
  const { path: relPath, name, fingerprint: recorded } = parseCodeLinkLine(line);
  const absolute = path.resolve(root, relPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`code link ${relPath}#${name}: path escapes the repository`);
  }
  let source;
  try {
    source = fs.readFileSync(absolute, 'utf8');
  } catch {
    throw new Error(`code link ${relPath}#${name}: ${relPath} does not exist in the repository`);
  }
  const { text, startLine } = extractSymbol(source, name, relPath);
  return { relPath, name, text, startLine, recorded, current: fingerprint(text, relPath) };
}
