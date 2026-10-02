#!/usr/bin/env node
// The part-registry checks: coverage (every tracked file belongs to exactly one part) and the PR
// docs answer (a part a change touches either has its pages changed or the PR body says why they
// are still true). One implementation, two callers — `ws ship` before it opens the PR, and CI on
// the PR — so the two can never disagree. Dependency-free on purpose: a single file another
// repository can fetch and run against its own docs-site/parts.json.
//
//   docs-parts.mjs coverage [--root <dir>] [--strict]
//   docs-parts.mjs answer   [--root <dir>] --base <ref> [--head <ref>] (--body-file <path> | --body-env <VAR>)
//   docs-parts.mjs links    [--root <dir>]            every code-link fingerprint still matches its function
//   docs-parts.mjs refresh  [--root <dir>] <page.md>…  re-stamp a page's fingerprints, after re-reading it
//   docs-parts.mjs boundaries [--root <dir>]          part ownership rules hold; crossings equal the baseline
//
// `links` and `boundaries` parse JavaScript with acorn, which the consumer installs (see acorn.mjs for
// where it is looked for); they say so (exit 2) when it is missing instead of passing.
//
// Exit 0 = fine (coverage problems are warnings unless --strict); 1 = a finding; 2 = could not
// decide (unreadable registry, git failure, bad usage) — never a silent pass.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcorn } from './acorn.mjs';

const REGISTRY = 'docs-site/parts.json';
const EXEMPT_FILE = 'docs-site/parts-exempt.json';

class Undecided extends Error {}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR'].includes(k)),
      ),
    });
  } catch (e) {
    throw new Undecided(`git ${args.join(' ')} failed: ${String(e.stderr || e.message).trim()}`);
  }
}

// A pattern is a directory prefix (trailing /), a glob where * stays inside one path segment, or an
// exact file (which also owns a directory of that name).
export function matches(pattern, file) {
  if (pattern.endsWith('/')) return file.startsWith(pattern);
  if (pattern.includes('*')) {
    const re = pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${re}$`).test(file);
  }
  return file === pattern || file.startsWith(`${pattern}/`);
}

export function owns(part, file) {
  const inc = part.owns.filter((p) => !p.startsWith('!'));
  const exc = part.owns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return inc.some((p) => matches(p, file)) && !exc.some((p) => matches(p, file));
}

export function loadParts(root) {
  const file = path.join(root, REGISTRY);
  if (!fs.existsSync(file)) return null;
  let parts;
  try {
    parts = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Undecided(`${REGISTRY} is unreadable: ${e.message}`);
  }
  if (!Array.isArray(parts) || parts.some((p) => !p.id || !Array.isArray(p.owns) || !p.source)) {
    throw new Undecided(`${REGISTRY} is not a list of parts with id, source and owns`);
  }
  return parts;
}

const isExempt = (exempt, file) => exempt.some((p) => matches(p, file));

function loadExempt(root) {
  const file = path.join(root, EXEMPT_FILE);
  if (!fs.existsSync(file)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(list)) throw new Error('not a list');
    return list;
  } catch (e) {
    throw new Undecided(`${EXEMPT_FILE} is unreadable: ${e.message}`);
  }
}

export function coverage(root) {
  const parts = loadParts(root);
  if (!parts) return { skipped: true, problems: [] };
  const exempt = loadExempt(root);
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const problems = [];
  for (const f of files) {
    if (isExempt(exempt, f)) continue;
    const hit = parts.filter((p) => owns(p, f)).map((p) => p.id);
    if (hit.length === 0) problems.push(`${f}: in no part`);
    else if (hit.length > 1) problems.push(`${f}: in ${hit.length} parts (${hit.join(', ')})`);
  }
  return { skipped: false, problems, checked: files.length };
}

// Matches `Docs: <part> still true — <why>` (em dash, en dash, hyphen or `--`), one per line.
export function stillTrueAnswers(body) {
  const answers = new Map();
  for (const line of String(body || '').split('\n')) {
    const m = /^\s*(?:[-*]\s*)?Docs:\s*([a-z0-9][a-z0-9-]*)\s+still true\s*(?:—|–|--|-)\s*(\S.*?)\s*$/i.exec(line);
    if (m) answers.set(m[1].toLowerCase(), m[2]);
  }
  return answers;
}

export function answer(root, { base, head = 'HEAD', body }) {
  const parts = loadParts(root);
  if (!parts) return { skipped: true, unanswered: [], touched: [] };
  const changed = git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`])
    .split('\0')
    .filter(Boolean);
  // Docs-like changes need no answer of their own: Markdown, the docs folder, a part's pages.
  const isPage = (f) => parts.some((p) => matches(`${p.source}/`, f));
  const isDocsLike = (f) => f.endsWith('.md') || f.startsWith('docs/') || isPage(f);
  const exempt = loadExempt(root);
  const answers = stillTrueAnswers(body);
  const touched = [];
  const unanswered = [];
  for (const part of parts) {
    const code = changed.filter((f) => !isDocsLike(f) && !isExempt(exempt, f) && owns(part, f));
    if (code.length === 0) continue;
    const pagesChanged = changed.some((f) => matches(`${part.source}/`, f));
    const why = answers.get(part.id);
    touched.push({ id: part.id, source: part.source, files: code, pagesChanged, why });
    if (!pagesChanged && !why) unanswered.push(part.id);
  }
  return { skipped: false, touched, unanswered };
}

// ---- code-link fingerprints ---------------------------------------------------------------------

// Every ```code-link fence in a tracked Markdown page, as { page, line, paragraph, index, text } per reference line.
// Only backtick fences indented at most three spaces are read, as in CommonMark; `~~~` fences are not.
// `paragraph` is the line number where the prose block before the fence starts, so a finding names
// the paragraph a reader has to re-read.
export function codeLinkLines(page, content) {
  const lines = content.split('\n');
  const found = [];
  let fence = null;
  let proseStart = 1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence === null) {
      const open = /^ {0,3}(`{3,})(.*)$/.exec(l);
      if (open) fence = { ticks: open[1].length, link: open[2].trim() === 'code-link', paragraph: proseStart };
      else if (l.trim() !== '' && (i === 0 || lines[i - 1].trim() === '')) proseStart = i + 1;
      continue;
    }
    const close = /^ {0,3}(`{3,})\s*$/.exec(l);
    if (close && close[1].length >= fence.ticks) fence = null;
    else if (fence.link && l.trim() !== '') {
      found.push({ page, line: i + 1, paragraph: fence.paragraph, index: i, text: l });
    }
  }
  if (fence !== null) throw new Undecided(`${page}: a code-link fence is never closed`);
  return found;
}

async function codeLinkModule() {
  try {
    return await import('./remark-code-links.mjs');
  } catch (e) {
    throw new Undecided(`cannot load acorn for code links (${e.message})`);
  }
}

const trackedPages = (root) => git(root, ['ls-files', '-z', '--', '*.md']).split('\0').filter(Boolean);

export async function links(root) {
  const { readCodeLink } = await codeLinkModule();
  const problems = [];
  let checked = 0;
  for (const page of trackedPages(root)) {
    for (const ref of codeLinkLines(page, fs.readFileSync(path.join(root, page), 'utf8'))) {
      checked++;
      const where = `${page}:${ref.line} (paragraph at line ${ref.paragraph})`;
      let link;
      try {
        link = readCodeLink(ref.text, root);
      } catch (e) {
        problems.push(`${where}: ${e.message}`);
        continue;
      }
      if (!link.recorded) {
        problems.push(
          `${where}: ${link.relPath}#${link.name} has no fingerprint — run: node scripts/docs-parts.mjs refresh ${page}`,
        );
      } else if (link.recorded !== link.current) {
        problems.push(
          `${where}: ${link.relPath}#${link.name} changed since the paragraph was confirmed (@${link.recorded}, now @${link.current}) — re-read the paragraph, then: node scripts/docs-parts.mjs refresh ${page}`,
        );
      }
    }
  }
  return { problems, checked };
}

export async function refresh(root, pages) {
  const { readCodeLink } = await codeLinkModule();
  const stamped = [];
  const writes = [];
  for (const page of pages) {
    const file = path.join(root, page);
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const ref of codeLinkLines(page, content)) {
      let link;
      try {
        link = readCodeLink(ref.text, root);
      } catch (e) {
        throw new Undecided(`${page}:${ref.line}: ${e.message} (nothing was stamped)`);
      }
      lines[ref.index] = `${link.relPath}#${link.name} @${link.current}`;
      stamped.push(`${page}:${ref.line} ${link.relPath}#${link.name} @${link.current}`);
    }
    writes.push([file, lines.join('\n')]);
  }
  for (const [file, text] of writes) fs.writeFileSync(file, text);
  return stamped;
}

// ---- boundary rules and the crossings ratchet ---------------------------------------------------

const BOUNDARIES = 'docs-site/boundaries.json';

function loadBoundaries(root, parts) {
  const file = path.join(root, BOUNDARIES);
  if (!fs.existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Undecided(`${BOUNDARIES} is unreadable: ${e.message}`);
  }
  const ids = new Set(parts.map((p) => p.id));
  for (const [id, b] of Object.entries(doc.parts || {})) {
    if (!ids.has(id)) throw new Undecided(`${BOUNDARIES}: part ${id} is not in ${REGISTRY}`);
    for (const r of b.rules || []) {
      if (!r.id || !['import', 'reference'].includes(r.kind) || !r.text)
        throw new Undecided(`${BOUNDARIES}: part ${id} has a rule without id, text and kind import|reference`);
      const strings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
      if (r.kind === 'import' && !(strings(r.from) && strings(r.forbid)))
        throw new Undecided(`${BOUNDARIES}: import rule ${r.id} needs from[] and forbid[] lists of strings`);
      if (r.except !== undefined && !strings(r.except))
        throw new Undecided(`${BOUNDARIES}: rule ${r.id} except must be a list of strings`);
      if (r.kind === 'reference') {
        if (!strings(r.in) || typeof r.pattern !== 'string')
          throw new Undecided(`${BOUNDARIES}: reference rule ${r.id} needs in[] and pattern`);
        try {
          new RegExp(r.pattern);
        } catch (e) {
          throw new Undecided(`${BOUNDARIES}: rule ${r.id} pattern is not a regular expression: ${e.message}`);
        }
      }
    }
  }
  return doc;
}

const anyMatch = (patterns, f) => patterns.some((p) => matches(p, f));

function importSpecifiers(acorn, file, source) {
  let program;
  try {
    program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch (e) {
    throw new Undecided(`${file} does not parse as a JavaScript module (${e.message})`);
  }
  const out = [];
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(n.type)) {
      const src = n.source;
      if (src && src.type === 'Literal' && typeof src.value === 'string') out.push(src.value);
    }
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require') {
      const [arg] = n.arguments;
      if (arg && arg.type === 'Literal' && typeof arg.value === 'string') out.push(arg.value);
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(program);
  return out;
}

export async function boundaries(root) {
  const parts = loadParts(root);
  if (!parts) return { skipped: true, problems: [] };
  const doc = loadBoundaries(root, parts);
  if (!doc)
    throw new Undecided(
      `${REGISTRY} exists but ${BOUNDARIES} does not — a missing rules file would switch the check off`,
    );
  let acorn;
  try {
    acorn = await loadAcorn();
  } catch (e) {
    throw new Undecided(`cannot load acorn for import rules (${e.message})`);
  }
  const files = git(root, ['ls-files', '-z']).split('\0').filter(Boolean);
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const problems = [];
  const seen = new Set();
  const cache = new Map();
  const specs = (f) => {
    if (!cache.has(f)) cache.set(f, importSpecifiers(acorn, f, read(f)));
    return cache.get(f);
  };
  let rules = 0;
  for (const [partId, b] of Object.entries(doc.parts || {})) {
    for (const r of b.rules || []) {
      rules++;
      const scope = files.filter(
        (f) => anyMatch(r.kind === 'import' ? r.from : r.in, f) && !anyMatch(r.except || [], f),
      );
      if (scope.length === 0) {
        problems.push(`${partId}/${r.id}: the rule matches no file, so it checks nothing`);
        continue;
      }
      for (const f of scope) {
        const found = new Set();
        if (r.kind === 'import') {
          if (/\.(?:ts|tsx|mts|cts)$/.test(f)) {
            problems.push(`${partId}/${r.id}: ${f} is TypeScript, which the import check cannot read`);
            continue;
          }
          if (!/\.(?:mjs|js|cjs)$/.test(f)) continue;
          for (const spec of specs(f)) {
            const target = spec.startsWith('.')
              ? path.posix.normalize(path.posix.join(path.posix.dirname(f), spec))
              : spec;
            if (anyMatch(r.forbid, target)) found.add(target);
          }
        } else {
          const re = new RegExp(r.pattern, 'g');
          for (const line of read(f).split('\n')) {
            if (/^\s*(#|\/\/)/.test(line)) continue;
            for (const m of line.matchAll(re)) found.add(m[0]);
          }
        }
        for (const target of found) seen.add(JSON.stringify([partId, r.id, f, target]));
      }
    }
  }
  const baseline = new Map();
  for (const [partId, b] of Object.entries(doc.parts || {})) {
    const contract = path.join(root, parts.find((p) => p.id === partId).source, 'contract.md');
    const contractFull = fs.existsSync(contract) ? fs.readFileSync(contract, 'utf8') : null;
    const at = contractFull === null ? -1 : contractFull.indexOf('Known boundary crossings');
    const contractText = at < 0 ? null : contractFull.slice(at);
    for (const c of b.crossings || []) {
      const key = JSON.stringify([partId, c.rule, c.file, c.target]);
      if (!(b.rules || []).some((r) => r.id === c.rule))
        problems.push(`${partId}: baseline crossing names unknown rule ${c.rule}`);
      if (contractText === null || !contractText.includes(c.file))
        problems.push(
          `${partId}: baseline crossing in ${c.file} is not listed under "Known boundary crossings" in its contract (${parts.find((p) => p.id === partId).source}/contract.md)`,
        );
      if (!c.why || !c.issue)
        problems.push(`${partId}: baseline crossing ${c.rule} ${c.file} needs a why and an issue`);
      baseline.set(key, `${partId}/${c.rule}: ${c.file} → ${c.target}`);
    }
  }
  for (const key of seen) {
    if (!baseline.has(key)) {
      const [partId, rule, file, target] = JSON.parse(key);
      problems.push(
        `${partId}/${rule}: NEW crossing ${file} → ${target} — fix it, or add it to ${BOUNDARIES} with a why and an issue, and to the contract`,
      );
    }
  }
  for (const [key, label] of baseline) {
    if (!seen.has(key))
      problems.push(`${label}: no longer occurs — remove it from the baseline so it cannot come back`);
  }
  return { skipped: false, problems, rules, crossings: baseline.size };
}

function parseArgs(argv) {
  const out = { cmd: argv[0], root: process.cwd(), strict: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') out.strict = true;
    else if (['--root', '--base', '--head', '--body-file', '--body-env'].includes(a)) {
      if (i + 1 >= argv.length) throw new Undecided(`${a} needs a value`);
      out[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new Undecided(`unknown argument ${a}`);
  }
  return out;
}

export function run(argv, { log = console.log, err = console.error } = {}) {
  try {
    const o = parseArgs(argv);
    o.root = path.resolve(o.root);
    if (o.cmd === 'coverage') {
      const r = coverage(o.root);
      if (r.skipped) {
        log(`docs parts: no ${REGISTRY} here — nothing to check`);
        return 0;
      }
      for (const p of r.problems) (o.strict ? err : log)(`${o.strict ? 'RED' : 'warn'} ${p}`);
      log(
        `docs parts: ${r.checked} files checked, ${r.problems.length} coverage problem(s)${o.strict ? '' : ' (warning only)'}`,
      );
      return o.strict && r.problems.length ? 1 : 0;
    }
    if (o.cmd === 'answer') {
      if (!o.base) throw new Undecided('answer needs --base');
      if (!o.bodyFile === !o.bodyEnv) throw new Undecided('answer needs exactly one of --body-file, --body-env');
      let body;
      if (o.bodyFile) body = fs.readFileSync(o.bodyFile, 'utf8');
      else if (o.bodyEnv in process.env) body = process.env[o.bodyEnv];
      else throw new Undecided(`environment variable ${o.bodyEnv} is not set`);
      const r = answer(o.root, { base: o.base, head: o.head, body });
      if (r.skipped) {
        log(`docs parts: no ${REGISTRY} here — nothing to check`);
        return 0;
      }
      for (const t of r.touched) {
        const state = t.pagesChanged ? 'pages changed' : t.why ? `still true — ${t.why}` : 'UNANSWERED';
        log(`part ${t.id}: ${t.files.length} file(s) changed; read ${t.source}/ (${state})`);
      }
      const sources = new Map(r.touched.map((t) => [t.id, t.source]));
      if (r.unanswered.length) {
        for (const id of r.unanswered) {
          err(
            `RED part ${id}: code changed but its pages did not — update ${sources.get(id)}/ or add to the PR body: Docs: ${id} still true — <why>`,
          );
        }
        return 1;
      }
      log('docs parts: every touched part is answered');
      return 0;
    }
    throw new Undecided('usage: docs-parts.mjs coverage|answer …');
  } catch (e) {
    if (e instanceof Undecided || e.code === 'ENOENT') {
      err(`docs parts: cannot decide — ${e.message}`);
      return 2;
    }
    throw e;
  }
}

export async function runAsync(argv, { log = console.log, err = console.error } = {}) {
  if (!['links', 'refresh', 'boundaries'].includes(argv[0])) return run(argv, { log, err });
  try {
    const rest = argv.slice(1);
    const rootAt = rest.indexOf('--root');
    const root = path.resolve(rootAt >= 0 ? rest[rootAt + 1] || '' : process.cwd());
    if (rootAt >= 0 && !rest[rootAt + 1]) throw new Undecided('--root needs a value');
    const extra = rest.filter((_, i) => rootAt < 0 || (i !== rootAt && i !== rootAt + 1));
    if (argv[0] === 'refresh') {
      if (!extra.length) throw new Undecided('refresh needs at least one page');
      for (const line of await refresh(root, extra)) log(`stamped ${line}`);
      return 0;
    }
    if (extra.length) throw new Undecided(`unknown argument ${extra[0]}`);
    const r = argv[0] === 'links' ? await links(root) : await boundaries(root);
    if (r.skipped) {
      log(`docs parts: no ${argv[0] === 'links' ? REGISTRY : BOUNDARIES} here — nothing to check`);
      return 0;
    }
    for (const p of r.problems) err(`RED ${p}`);
    log(
      argv[0] === 'links'
        ? `docs parts: ${r.checked} code link(s) checked, ${r.problems.length} problem(s)`
        : `docs parts: ${r.rules} boundary rule(s), ${r.crossings} baseline crossing(s), ${r.problems.length} problem(s)`,
    );
    return r.problems.length ? 1 : 0;
  } catch (e) {
    if (e instanceof Undecided || e.code === 'ENOENT') {
      err(`docs parts: cannot decide — ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(await runAsync(process.argv.slice(2)));
}
