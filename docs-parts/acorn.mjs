// Finds acorn, the JavaScript parser the code-link fingerprints and import rules read code with.
// Nothing is bundled: the consumer already installs acorn, and this finds it rather than carrying a
// second copy that could drift. Order: $ACORN_PATH (a file), the bare name from where this file
// sits, then the consumer's own docs-site/node_modules and node_modules under the directory the
// command runs in. Finding none is an error that says so, never a quiet pass.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadAcorn() {
  const tried = [];
  const candidates = [
    process.env.ACORN_PATH,
    'acorn',
    path.join(process.cwd(), 'docs-site/node_modules/acorn/dist/acorn.mjs'),
    path.join(process.cwd(), 'node_modules/acorn/dist/acorn.mjs'),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      return await import(path.isAbsolute(c) ? pathToFileURL(c).href : c);
    } catch (e) {
      tried.push(`${c} (${e.code ?? e.message})`);
    }
  }
  throw new Error(`cannot load acorn — install it or set ACORN_PATH; tried ${tried.join(', ')}`);
}
