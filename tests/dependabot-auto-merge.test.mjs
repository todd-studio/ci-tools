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

test('held updates create complete assigned review work and reuse it across runs and heads', (t) => {
  const { settingsPath, settings } = setup(t);
  settings({ ecosystems: ['npm_and_yarn'], reviewPriorityFieldId: 46102352 });
  const captured = readFixture('dependabot-auto-merge/held-pull.json');
  const capturedIssue = readFixture('dependabot-auto-merge/held-issue.json');
  const capturedMetadata = readFixture('dependabot-auto-merge/held-metadata.json');
  const capturedTimeline = readFixture('dependabot-auto-merge/held-timeline.json');
  // Replay WS 5680 while open; issue writes replay CI 47 with the submitted
  // routing body and CI 49's workflow-token metadata. Deliberate state/head edits
  // below exercise the trust boundary.
  let current = { ...captured, state: 'open' };
  let currentEvent = {
    repository: { id: captured.base.repo.id, full_name: 'todd-studio/workstation', default_branch: 'main' },
    pull_request: current,
  };
  let dependencies = metadata.map((dep) => ({ ...dep, updateType: 'version-update:semver-major' }));
  let issues = [];
  let writes = 0;
  let listReply;
  let beforeWrite;
  let omitMetadataReadback = false;
  const run = () => armAutoMerge({
    event: currentEvent, dependencies, settingsPath, shouldRouteHeld: true,
    gh: (args) => {
      assert.equal(args[0], 'api', 'routing must never arm a merge');
      if (args[1].includes('/pulls/')) return JSON.stringify(current);
      if (args.includes('--paginate')) {
        assert.equal(args[1], 'repos/todd-studio/workstation/issues/5680/timeline?per_page=100',
          'the lookup reads only the source PR timeline, never the repository issue history');
        beforeWrite?.();
        if (listReply) return listReply;
        // GitHub cross-references each issue whose body links the PR, beside its
        // other references (the captured ones); gh applies the script's filter.
        const linking = issues.filter((issue) => /\/todd-studio\/workstation\/pull\/5680\b/.test(issue.body ?? ''));
        const timeline = [...capturedTimeline, ...linking.map((issue) => ({ ...capturedTimeline[0], source: {
          ...capturedTimeline[0].source,
          issue: { repository_url: 'https://api.github.com/repos/todd-studio/workstation', ...issue },
        } }))];
        return execFileSync('jq', ['-r', args[args.indexOf('--jq') + 1]], { input: JSON.stringify(timeline), encoding: 'utf8' });
      }
      if (!args.includes('--method')) {
        return JSON.stringify(omitMetadataReadback ? { ...issues.at(-1), issue_field_values: [] } : issues.at(-1));
      }
      if (args[args.indexOf('--method') + 1] === 'PATCH') {
        writes++;
        issues[0] = { ...issues[0], type: capturedMetadata.type };
        return JSON.stringify(issues[0]);
      }
      assert.equal(args[args.indexOf('--method') + 1], 'POST');
      writes++;
      if (args[1].endsWith('/assignees')) {
        issues[0] = { ...issues[0], assignees: capturedIssue.assignees };
        return JSON.stringify(issues[0]);
      }
      if (args[1].endsWith('/issue-field-values')) {
        assert.ok(args.includes('issue_field_values[][field_id]=46102352'));
        assert.ok(args.includes('issue_field_values[][value]=Medium'));
        issues[0].issue_field_values = capturedMetadata.issue_field_values;
        return JSON.stringify(issues[0].issue_field_values);
      }
      const body = args.find((arg) => arg.startsWith('body=')).slice(5);
      assert.ok(args.includes('assignees[]=toddagent01'));
      assert.ok(args.includes('type=Maintenance'));
      assert.ok(args.includes('issue_field_values[][field_id]=46102352'));
      assert.ok(args.includes('issue_field_values[][value]=Medium'));
      assert.doesNotMatch(body, /Priority:/);
      assert.match(body, /https:\/\/github.com\/todd-studio\/workstation\/pull\/5680/);
      assert.match(body, /Merge it.*or close it with a reason/);
      assert.match(body, /## Proof/);
      assert.match(body, new RegExp(current.head.sha));
      issues.push({ ...capturedIssue, ...capturedMetadata, body });
      return JSON.stringify(issues.at(-1));
    },
  });
  assert.match(run(), /Review work created/);
  assert.match(run(), /Review work reused/);
  current = { ...current, head: { ...current.head, sha: 'a'.repeat(40) } };
  currentEvent = { ...currentEvent, pull_request: current };
  assert.match(run(), /Review work reused/);
  assert.equal(writes, 1);
  issues[0].assignees = [];
  assert.match(run(), /Review work reused/);
  assert.equal(writes, 2, 'open work is repaired if assignment was lost');
  issues[0].state = 'closed';
  assert.match(run(), /Review work reused.*closed/);
  assert.equal(writes, 2, 'closed work does not start another lane');
  const trusted = structuredClone(current);
  for (const edit of [
    (pr) => { pr.state = 'closed'; }, (pr) => { pr.draft = true; },
    (pr) => { pr.user.id = 1; }, (pr) => { pr.user.type = 'User'; },
    (pr) => { pr.head.repo.id = 1; }, (pr) => { pr.base.repo.id = 1; },
    (pr) => { pr.base.ref = 'other'; }, (pr) => { pr.head.sha = 'b'.repeat(40); },
  ]) {
    current = structuredClone(trusted);
    edit(current);
    assert.match(run(), /Not routed/);
    assert.equal(writes, 2);
  }
  current = trusted;
  dependencies = metadata;
  assert.match(run(), /Not routed: no held trusted update/);
  assert.equal(writes, 2);
  dependencies = metadata.map((dep) => ({ ...dep, updateType: 'version-update:semver-major' }));
  listReply = '{}';
  assert.throws(run, /Unreadable review issue list/);
  listReply = undefined;
  issues = [];
  beforeWrite = () => { current = { ...trusted, state: 'closed' }; };
  assert.match(run(), /Not routed: pull request changed/);
  assert.equal(writes, 2);
  current = trusted;
  beforeWrite = undefined;
  issues = [];
  omitMetadataReadback = true;
  assert.throws(run, /Review issue metadata or assignment was not applied/,
    'a successful create reply is insufficient when fresh native-field readback disagrees');
  omitMetadataReadback = false;
  issues[0].issue_field_values = [];
  delete issues[0].type;
  assert.match(run(), /Review work reused/);
  assert.equal(issues[0].type.name, 'Maintenance');
  assert.equal(issues[0].issue_field_values[0].single_select_option.name, 'Medium');
  settings({ ecosystems: ['npm_and_yarn'] });
  assert.throws(run, /requires reviewPriorityFieldId/);
  settings({ ecosystems: ['npm_and_yarn'], reviewPriorityFieldId: 46102352 });
  const genuine = structuredClone(issues[0]);
  // A public marker authenticates nothing. Replay a real non-workflow creator,
  // including a spoof that copies the bot's login, ID or type individually, and
  // the same bot creating the issue from another repository's workflow.
  for (const forged of [
    { user: capturedIssue.user },
    { user: { ...capturedIssue.user, login: capturedMetadata.user.login } },
    { user: { ...capturedIssue.user, id: capturedMetadata.user.id } },
    { user: { ...capturedMetadata.user, id: capturedIssue.user.id } },
    { user: undefined },
    { repository_url: capturedTimeline[1].source.issue.repository_url },
  ]) {
    for (const state of ['open', 'closed']) {
      const spoof = { ...genuine, number: capturedIssue.number, state, assignees: [], ...forged,
        body: `${genuine.body.split('\n')[0]}\nUnrelated opener-controlled text about https://github.com/todd-studio/workstation/pull/5680` };
      issues = [structuredClone(spoof)];
      const before = writes;
      assert.match(run(), /Review work created/, 'ignore open and closed marker spoofs');
      assert.deepEqual(issues[0], spoof, 'never repair or assign the untrusted issue');
      assert.equal(writes, before + 1, 'only create genuine assigned work');
      assert.match(run(), /Review work reused/, 'genuine work wins over an earlier spoof');
      assert.equal(writes, before + 1);
    }
  }
});
