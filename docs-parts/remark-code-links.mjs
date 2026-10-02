// Remark plugin: turn a ```code-link fence into the live source of the functions it names.
//
//   ```code-link
//   services/issue-router/linear-session.mjs#someFunction
//   ```
//
// On GitHub the fence reads as a plain list of references; on the site each line becomes a
// highlighted code block titled with its path and name. The source is read from the repository
// checkout at build time, so the block always shows the code the site was built from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSymbol, fingerprint, parseCodeLinkLine } from './code-links.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function readCodeLink(line, root = repoRoot) {
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

// The checkout a page's code links read from: its routed repository's, else this repository's.
let routedRepos;
function rootFor(file, root) {
  const id = /\/docs\/repos\/([^/]+)\//.exec(String(file?.path ?? '').replace(/\\/g, '/'))?.[1];
  if (!id) return root;
  routedRepos ??= JSON.parse(fs.readFileSync(path.resolve('.site-content/routed-checkouts.json'), 'utf8'));
  const repos = routedRepos;
  if (!repos[id]) throw new Error(`code link on a page of ${id}: no checkout recorded for it`);
  return repos[id].root;
}

export function remarkCodeLinks({ root = repoRoot } = {}) {
  return (tree, file) => {
    const pageRoot = rootFor(file, root);
    const visit = (node) => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'code' || child.lang !== 'code-link') {
          visit(child);
          return [child];
        }
        return child.value
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => {
            const link = readCodeLink(line, pageRoot);
            return {
              type: 'code',
              lang: link.relPath.endsWith('.sh') ? 'bash' : link.relPath.endsWith('.py') ? 'python' : 'js',
              meta: `title="${link.relPath} › ${link.name}"`,
              value: link.text,
            };
          });
      });
    };
    visit(tree);
  };
}

export default remarkCodeLinks;
