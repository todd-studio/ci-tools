import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { armAutoMerge } from '../dependabot-auto-merge/dependabot-auto-merge.mjs';
import { readFixture } from './helpers/fixtures.mjs';

const capturedPull = readFixture('dependabot-auto-merge/plates-web-1689-pull.json');
const metadata = readFixture('dependabot-auto-merge/plates-web-1689-metadata.json');
// Replay the captured PR before its merge. All other edits below are deliberate
// eligibility failures or policy choices applied to the real adapter replies.
const pull = { ...capturedPull, state: 'open', auto_merge: null };
const event = {
  repository: { id: pull.base.repo.id, full_name: 'todd-studio/plates-web', default_branch: pull.base.ref },
  pull_request: pull,
};

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dependabot-auto-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, 'settings.json');
  const settings = (value) => writeFileSync(settingsPath, JSON.stringify(value));
  settings({ ecosystems: ['npm_and_yarn'] });
  const run = (pr = pull, dependencies = metadata, extra = {}) => {
    const calls = [];
    const result = armAutoMerge({
      event, dependencies, settingsPath,
      gh: (args) => {
        calls.push(args);
        if (args[0] === 'api') return JSON.stringify(pr);
        return '';
      },
      ...extra,
    });
    return { calls, result };
  };
  return { root, settingsPath, settings, run };
}

test('only eligible exact-head Dependabot minor/patch updates request squash auto-merge', (t) => {
  const { run, settings } = setup(t);
  assert.deepEqual(run().calls, [
    ['api', 'repos/todd-studio/plates-web/pulls/1689'],
    ['pr', 'merge', '1689', '--repo', 'todd-studio/plates-web', '--auto', '--squash', '--match-head-commit', pull.head.sha],
  ]);
  const changed = (edit) => {
    const pr = structuredClone(pull);
    edit(pr);
    return pr;
  };
  for (const pr of [
    changed((pr) => { pr.user.id = 123; }),
    changed((pr) => { pr.user.type = 'User'; }),
    changed((pr) => { pr.head.repo.id = 123; }),
    changed((pr) => { pr.base.repo.id = 123; }),
    changed((pr) => { pr.head.sha = 'a'.repeat(40); }),
    changed((pr) => { pr.base.ref = 'other'; }),
    changed((pr) => { pr.commits = 2; }),
    changed((pr) => { delete pr.commits; }),
    changed((pr) => { pr.draft = true; }),
    changed((pr) => { pr.state = 'closed'; }),
  ]) {
    assert.equal(run(pr).calls.length, 1, JSON.stringify(pr));
  }
  for (const dependencies of [
    [], null, {}, [null],
    metadata.map((dep) => ({ ...dep, packageEcosystem: 'github_actions' })),
    [...metadata, { ...metadata[0], updateType: 'version-update:semver-major' }],
    [{ ...metadata[0], updateType: 'unknown' }],
    [{ ...metadata[0], updateType: undefined }],
  ]) {
    assert.equal(run(pull, dependencies).calls.length, 1, JSON.stringify(dependencies));
  }
  // Ecosystem policy is consumer configuration, including groups: every member must qualify.
  settings({ ecosystems: ['github_actions', 'uv'] });
  const group = metadata.slice(0, 2).map((dep, i) => ({ ...dep, packageEcosystem: i ? 'uv' : 'github_actions' }));
  assert.equal(run(pull, group).calls.length, 2);
  assert.equal(run().calls.length, 1);
  settings({ ecosystems: ['github_actions'] });
  assert.equal(run(pull, group).calls.length, 1);
  assert.throws(() => run(pull, metadata, { gh: () => 'truncated' }));
  assert.throws(() => run(pull, metadata, { gh: () => { throw new Error('API unavailable'); } }));
});

test('missing, unreadable and malformed settings throw before any merge mutation', (t) => {
  const { settingsPath, settings, run } = setup(t);
  const noMutation = {
    gh: (args) => {
      assert.equal(args[0], 'api', 'invalid settings must never call gh pr merge');
      return JSON.stringify(pull);
    },
  };
  for (const value of [null, [], {}, { ecosystems: [] }, { ecosystems: 'npm_and_yarn' },
    { ecosystems: [null] }, { ecosystems: [''] }, { ecosystems: ['github-actions'] },
    { ecosystems: ['npm_and_yarn'], unknown: true }]) {
    settings(value);
    assert.throws(() => run(pull, metadata, noMutation), /Invalid Dependabot auto-merge settings/);
  }
  writeFileSync(settingsPath, '{');
  assert.throws(() => run(pull, metadata, noMutation), SyntaxError);
  rmSync(settingsPath);
  assert.throws(() => run(pull, metadata, noMutation), /ENOENT/);
  mkdirSync(settingsPath);
  assert.throws(() => run(pull, metadata, noMutation), /EISDIR/);
});

test('clear withdraws a prior request even without settings or metadata; unreadable state fails', (t) => {
  const { settingsPath, run } = setup(t);
  rmSync(settingsPath);
  assert.deepEqual(run(capturedPull, undefined, { shouldClear: true }).calls, [
    ['api', 'repos/todd-studio/plates-web/pulls/1689'],
    ['pr', 'merge', '1689', '--repo', 'todd-studio/plates-web', '--disable-auto'],
  ]);
  assert.equal(run(pull, undefined, { shouldClear: true }).calls.length, 1);
  const unreadable = { ...pull };
  delete unreadable.auto_merge;
  assert.throws(() => run(unreadable, undefined, { shouldClear: true }), /Unreadable auto-merge state/);
});

test('the standalone CLI runs through a symlink, reads cwd settings, and clear ignores them', (t) => {
  const { root } = setup(t);
  mkdirSync(join(root, '.github'));
  writeFileSync(join(root, '.github/dependabot-auto-merge.json'), JSON.stringify({ ecosystems: ['npm_and_yarn'] }));
  writeFileSync(join(root, 'event.json'), JSON.stringify(event));
  writeFileSync(join(root, 'pull.json'), JSON.stringify(pull));
  const calls = join(root, 'calls');
  // The external gh adapter replays the captured reply; no network mutation occurs.
  writeFileSync(join(root, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_CALLS"\nif [ "$1" = api ]; then cat "$GH_REPLY"; fi\n', { mode: 0o700 });
  symlinkSync(resolve('dependabot-auto-merge/dependabot-auto-merge.mjs'), join(root, 'script.mjs'));
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, GITHUB_EVENT_PATH: join(root, 'event.json'),
    GH_CALLS: calls, GH_REPLY: join(root, 'pull.json'), UPDATED_DEPENDENCIES: JSON.stringify(metadata) };
  const cli = (args = [], extraEnv = {}) => execFileSync(process.execPath, [join(root, 'script.mjs'), ...args],
    { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(cli(), /Squash auto-merge requested/);
  assert.match(readFileSync(calls, 'utf8'), new RegExp(`--match-head-commit ${pull.head.sha}`));
  rmSync(join(root, '.github/dependabot-auto-merge.json'));
  writeFileSync(calls, '');
  assert.throws(() => cli(), /ENOENT/);
  assert.doesNotMatch(readFileSync(calls, 'utf8'), /pr merge/);
  assert.match(cli(['--clear'], { UPDATED_DEPENDENCIES: 'malformed' }), /Prior auto-merge cleared/);
});
