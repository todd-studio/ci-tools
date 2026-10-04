import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// A fixture file is {"source": "<command> — captured <date> on <account>@<Mac>", "reply": <verbatim
// real body>}; the source travels beside the payload so it is never mistaken for part of it.
export function readFixture(relPath) {
  return JSON.parse(readFileSync(join(FIXTURES_ROOT, relPath), 'utf8')).reply;
}
