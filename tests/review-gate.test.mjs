import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dependabotAttested,
  guardedSurface,
  guardedTouch,
  importClosure,
  main,
  parseLane,
  readSettings,
  reviewerVerdict,
  priorReviewerVerdict,
  reviewerWithdrewOn,
  treeIndex,
  mergeTreeIndex,
  treeIndexesEqual,
  treesCarryApproval,
} from '../review-gate/review-gate.mjs';
import { readFixture } from './helpers/fixtures.mjs';

const HEAD = '18beab14bb08d1fbf0565e93fd966fb2a8933275';
const OLD = '3930fbfcd43950e8bc701f7a4b5ad64dee8f2739';
const EARLY = '2026-09-13T00:00:00Z';
const LATE = '2026-09-13T00:01:00Z';

const review = (head = HEAD, state = 'APPROVED', id = 7, submittedAt = LATE, login = 'toddreviewer01') => ({
  id,
  state,
  commit_id: head,
  submitted_at: submittedAt,
  body: 'prose is not evidence',
  user: { login },
});

// A real toddreviewer01 APPROVED review captured from PR #2277 (see the fixture's own "source"
// field), with every field GitHub actually sends — not the five fields `review()` above guesses at.
const REAL_APPROVAL = readFixture('review-gate/pulls-1-reviews-approved.json');
const REAL_HEAD = REAL_APPROVAL[0].commit_id;
// A real pull-request file list (one entry); `fileNamed` keeps its shape and changes the path.
const REAL_FILES = readFixture('review-gate/dependabot-pull-actions-checkout-2590-files.json');
const fileNamed = (filename, extra = {}) => ({ ...REAL_FILES[0], filename, ...extra });

test('lane parsing ignores the template placeholder and multiline comments', () => {
  assert.equal(parseLane('- Lane: <!-- ordinary / guarded -->'), 'undeclared');
  assert.equal(parseLane('<!--\n- Lane: ordinary\n-->\n- Lane: guarded, login'), 'guarded');
  assert.equal(parseLane('<!--\n- Lane: ordinary\n'), 'undeclared');
});

test('lane parsing accepts only a bare first lane token', () => {
  assert.equal(parseLane('- Lane: ordinary, docs only'), 'ordinary');
  assert.equal(parseLane('- Lane: guarded (security)'), 'guarded');
  assert.equal(parseLane('- Lane: maybe ordinary'), 'undeclared');
  assert.equal(parseLane(null), 'undeclared');
});

test('the latest decisive exact-head native review wins', () => {
  assert.deepEqual(
    reviewerVerdict([review(HEAD, 'APPROVED', 1, EARLY), review(HEAD, 'CHANGES_REQUESTED', 2, LATE)], HEAD),
    { ok: false, id: 2, submittedAt: LATE },
  );
  assert.equal(
    reviewerVerdict([review(HEAD, 'CHANGES_REQUESTED', 1, EARLY), review(HEAD, 'APPROVED', 2, LATE)], HEAD)?.ok,
    true,
  );
});

test('same-instant decisions are ordered by review id', () => {
  assert.equal(
    reviewerVerdict([review(HEAD, 'APPROVED', 1, LATE), review(HEAD, 'CHANGES_REQUESTED', 2, LATE)], HEAD)?.ok,
    false,
  );
});

test('other heads, identities, comments and dismissed reviews are not verdicts', () => {
  assert.equal(reviewerVerdict([review(OLD)], HEAD), null);
  assert.equal(reviewerVerdict([review(HEAD, 'APPROVED', 1, LATE, 'someone-else')], HEAD), null);
  assert.equal(reviewerVerdict([review(HEAD, 'COMMENTED')], HEAD), null);
  assert.equal(reviewerVerdict([review(HEAD, 'DISMISSED')], HEAD), null);
  assert.equal(reviewerVerdict([review(HEAD, 'APPROVED', 1, EARLY), review(HEAD, 'DISMISSED', 2, LATE)], HEAD), null);
});

test('review prose can neither approve nor reject', () => {
  assert.equal(reviewerVerdict([{ ...review(), body: `REJECT ${HEAD}` }], HEAD)?.ok, true);
  assert.equal(reviewerVerdict([{ ...review(HEAD, 'CHANGES_REQUESTED'), body: `APPROVED ${HEAD}` }], HEAD)?.ok, false);
});

test('unreadable exact-head decision ordering fails closed', () => {
  assert.throws(() => reviewerVerdict([review(HEAD, 'APPROVED', 1, 'yesterday')], HEAD), /submission time/);
  assert.throws(() => reviewerVerdict([review(HEAD, 'APPROVED', null)], HEAD), /inventory/);
  assert.equal(reviewerVerdict([review(OLD, 'APPROVED', 1, 'yesterday')], HEAD), null);
  assert.throws(() => reviewerVerdict(null, HEAD), /inventory/);
});

test('a malformed newer review cannot leave an older approval green', () => {
  // A missing state must fail closed on the whole inventory, not be silently
  // discarded by the verdict state filter while an older APPROVED on this head
  // stands as the latest verdict.
  assert.throws(
    () =>
      reviewerVerdict(
        [review(HEAD, 'APPROVED', 1, EARLY), { id: 2, commit_id: HEAD, user: { login: 'toddreviewer01' } }],
        HEAD,
      ),
    /inventory/,
  );
});

const THIRD = '5c1f1e0c2f7a9b3d8e4f6a1c0b2d3e4f5a6b7c8d';

test('a reviewer verdict on another head, read with the same per-head reduction', () => {
  assert.equal(priorReviewerVerdict([review(HEAD)], HEAD), null);
  assert.deepEqual(priorReviewerVerdict([review(OLD, 'CHANGES_REQUESTED')], HEAD), {
    ok: false,
    id: 7,
    submittedAt: LATE,
    head: OLD,
  });
  const later = review(THIRD, 'APPROVED', 8, '2026-09-13T00:02:00Z');
  assert.equal(priorReviewerVerdict([review(OLD, 'CHANGES_REQUESTED'), later], HEAD).id, 8);
  assert.equal(priorReviewerVerdict([review(OLD, 'APPROVED', 7, LATE, 'coderabbitai[bot]')], HEAD), null);
  assert.equal(priorReviewerVerdict([review(OLD, 'COMMENTED')], HEAD), null);
});

test('a dismissal naming this exact head is withdrawn, whatever an older head approved', () => {
  assert.equal(reviewerWithdrewOn([review(HEAD, 'APPROVED')], HEAD), false);
  assert.equal(reviewerWithdrewOn([review(HEAD, 'DISMISSED')], HEAD), true);
  assert.equal(reviewerWithdrewOn([review(OLD, 'DISMISSED')], HEAD), false);
  assert.equal(reviewerWithdrewOn([review(HEAD, 'DISMISSED', 1, LATE, 'someone-else')], HEAD), false);
});

test('a truncated or malformed tree listing is no tree at all', () => {
  assert.throws(() => treeIndex({ truncated: true, tree: [] }), /truncated/);
  assert.throws(() => treeIndex({ tree: 'not a list' }), /no entries/);
  assert.throws(() => treeIndex({ tree: [{ path: 'a', mode: '100644', type: 'blob' }] }), /not readable/);
  assert.throws(() => treeIndex(null), /not an object/);
});

test('a tree index carries blobs with their mode and drops directory entries', () => {
  const index = treeIndex({
    truncated: false,
    tree: [
      { path: 'dir', mode: '040000', type: 'tree', sha: 't1' },
      { path: 'dir/a', mode: '100644', type: 'blob', sha: 'a1' },
      { path: 'x.sh', mode: '100755', type: 'blob', sha: 'x1' },
    ],
  });
  assert.deepEqual(
    [...index.entries()],
    [
      ['dir/a', '100644 blob a1'],
      ['x.sh', '100755 blob x1'],
    ],
  );
});

test('a mode change alone is a difference between two otherwise-equal trees', () => {
  const a = treeIndex({ tree: [{ path: 'x.sh', mode: '100644', type: 'blob', sha: 'x1' }] });
  const b = treeIndex({ tree: [{ path: 'x.sh', mode: '100755', type: 'blob', sha: 'x1' }] });
  assert.equal(treeIndexesEqual(a, b), false);
});

test("the three-way merge takes each side's own change and refuses a path both sides moved", () => {
  const index = (entries) => new Map(Object.entries(entries));
  const base = index({ a: '1', b: '1', gone: '1' });
  assert.deepEqual(
    [...mergeTreeIndex(base, index({ a: '2', b: '1', gone: '1' }), index({ a: '1', b: '2' }))],
    [
      ['a', '2'],
      ['b', '2'],
    ],
  );
  assert.equal(mergeTreeIndex(base, index({ a: '2', b: '1', gone: '1' }), index({ a: '3', b: '1', gone: '1' })), null);
  assert.deepEqual(
    [...mergeTreeIndex(base, index({ a: '1', b: '1' }), index({ a: '1', b: '1' }))],
    [
      ['a', '1'],
      ['b', '1'],
    ],
  );
});

const blob = (sha) => ({ mode: '100644', type: 'blob', sha });
const treeOf = (entries) => ({
  truncated: false,
  tree: Object.entries(entries).map(([path, sha]) => ({ path, ...blob(sha) })),
});

test('a head that only merges the base branch into the approved tree carries the approval', () => {
  // fork: a1 b1   approved: a2 b1   base-taken: a1 b2   landing: a2 b2
  assert.equal(
    treesCarryApproval({
      base: treeOf({ a: 'a1', b: 'b1' }),
      approved: treeOf({ a: 'a2', b: 'b1' }),
      taken: treeOf({ a: 'a1', b: 'b2' }),
      landing: treeOf({ a: 'a2', b: 'b2' }),
    }),
    true,
  );
});

test('a landing tree carrying its own change on top of the merge is never covered', () => {
  assert.equal(
    treesCarryApproval({
      base: treeOf({ a: 'a1', b: 'b1' }),
      approved: treeOf({ a: 'a2', b: 'b1' }),
      taken: treeOf({ a: 'a1', b: 'b2' }),
      landing: treeOf({ a: 'a2', b: 'b2', c: 'c9' }),
    }),
    false,
  );
});

test('a path the change and the base branch both moved conflicts, so nothing carries', () => {
  // A resolution that kept the change's side of `a` produces a landing tree
  // identical to the change alone — exactly the content nobody reviewed, so
  // this must refuse rather than agree with it.
  assert.equal(
    treesCarryApproval({
      base: treeOf({ a: 'a1', b: 'b1' }),
      approved: treeOf({ a: 'a2', b: 'b1' }),
      taken: treeOf({ a: 'a3', b: 'b2' }),
      landing: treeOf({ a: 'a2', b: 'b2' }),
    }),
    false,
  );
});

test('a truncated tree anywhere in the comparison refuses the carry, never completes it', () => {
  assert.throws(
    () =>
      treesCarryApproval({
        base: treeOf({ a: 'a1', b: 'b1' }),
        approved: treeOf({ a: 'a2', b: 'b1' }),
        taken: treeOf({ a: 'a1', b: 'b2' }),
        landing: { ...treeOf({ a: 'a2', b: 'b2' }), truncated: true },
      }),
    /truncated/,
  );
});

// The gate runs in the consuming repository's trusted checkout and reads its
// settings from there, so each run gets a scratch checkout to stand in it.
// `files` maps repository paths to text; `settings` is written verbatim when a
// string, as JSON otherwise.
function runtimeEnv(t, event, { settings, files = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'review-gate-test-'));
  const eventPath = join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify(event));
  const checkout = join(directory, 'checkout');
  const write = (file, text) => {
    mkdirSync(join(checkout, file, '..'), { recursive: true });
    writeFileSync(join(checkout, file), text);
  };
  mkdirSync(checkout);
  if (settings !== undefined)
    write('.github/review-gate.json', typeof settings === 'string' ? settings : JSON.stringify(settings));
  for (const [file, text] of Object.entries(files)) write(file, text);
  const savedCwd = process.cwd();
  process.chdir(checkout);
  const saved = { ...process.env };
  const savedFetch = globalThis.fetch;
  process.env.GITHUB_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'o/r';
  process.env.GITHUB_EVENT_PATH = eventPath;
  process.env.GITHUB_RUN_ID = '123456';
  process.env.GITHUB_SERVER_URL = 'https://github.com';
  t.after(() => {
    process.chdir(savedCwd);
    process.env = saved;
    globalThis.fetch = savedFetch;
    rmSync(directory, { recursive: true, force: true });
  });
}

function stubFetch({
  lane = 'guarded',
  heads = [HEAD, HEAD],
  author = 'author',
  reviews = [],
  reviewStatus = 200,
  associated = [{ number: 1, state: 'open', head: { sha: HEAD } }],
  base = 'main',
  compares = {},
  trees = {},
  comparesFail = false,
  files = REAL_FILES,
  fileStatus = 200,
  commits = [],
  commitStatus = 200,
  pull = null,
} = {}) {
  const statuses = [];
  const calls = [];
  let pullIndex = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url).replace('https://api.github.com', '');
    calls.push([path, init]);
    const ok = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => '' });
    const fail = (status = 500, body = 'boom') => ({
      ok: false,
      status,
      json: async () => ({}),
      text: async () => body,
    });
    if (init.method === 'POST' && path.includes('/statuses/')) {
      statuses.push(JSON.parse(init.body));
      return ok({ id: statuses.length });
    }
    if (path.includes(`/commits/${HEAD}/pulls`)) return ok(associated);
    if (path.includes('/pulls/1/reviews')) {
      if (reviewStatus !== 200) return fail(reviewStatus, 'boom');
      return ok(reviews);
    }
    if (path.startsWith('/repos/o/r/pulls/1/files')) return fileStatus === 200 ? ok(files) : fail(fileStatus);
    if (path.startsWith('/repos/o/r/pulls/1/commits')) return commitStatus === 200 ? ok(commits) : fail(commitStatus);
    if (path.startsWith('/repos/o/r/compare/')) {
      if (comparesFail) return fail();
      const key = path.slice('/repos/o/r/compare/'.length);
      if (!(key in compares)) throw new Error(`unrouted compare: ${key}`);
      return ok(compares[key]);
    }
    if (path.startsWith('/repos/o/r/git/trees/')) {
      const sha = path.slice('/repos/o/r/git/trees/'.length).split('?')[0];
      if (!(sha in trees)) throw new Error(`unrouted tree: ${sha}`);
      return ok(trees[sha]);
    }
    if (path === '/repos/o/r/pulls/1') {
      const head = heads[Math.min(pullIndex, heads.length - 1)];
      pullIndex += 1;
      if (pull) return ok({ ...pull, head: { ...pull.head, sha: head } });
      return ok({
        head: { sha: head },
        base: { ref: base },
        user: author === null ? null : { login: author, id: 42, type: 'User' },
        body: lane === null ? null : `- Lane: ${lane}`,
        html_url: 'https://github.com/o/r/pull/1',
      });
    }
    throw new Error(`unrouted fetch: ${path}`);
  };
  return { statuses, calls };
}

const pullEvent = (head = HEAD) => ({ pull_request: { number: 1, head: { sha: head } } });
const reviewWake = (head = HEAD) => ({
  workflow_run: {
    event: 'pull_request_review',
    status: 'completed',
    conclusion: 'success',
    head_sha: head,
  },
});

test('ordinary succeeds without any reviewer or CodeRabbit read', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses, calls } = stubFetch({ lane: 'ordinary' });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
  assert.equal(statuses.at(-1).description, 'ordinary: required CI is independently enforced');
  assert.equal(
    calls.some(([path]) => path.includes('/reviews')),
    false,
  );
  assert.equal(
    calls.some(([path]) => path.includes('CodeRabbit')),
    false,
  );
});

test('guarded succeeds only on the exact-head reviewer approval', async (t) => {
  runtimeEnv(t, pullEvent(REAL_HEAD));
  const { statuses } = stubFetch({ heads: [REAL_HEAD, REAL_HEAD], reviews: REAL_APPROVAL });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
  assert.match(statuses.at(-1).description, new RegExp(`exact-head reviewer approval.*review ${REAL_APPROVAL[0].id}`));
});

test('undeclared is guarded and a missing verdict is red', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({ lane: 'unrecognised', reviews: [] });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /no readable Lane declaration \(treated as guarded\)/);
});

test('a changes request is red and an old-head approval cannot satisfy a push', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({ reviews: [review(OLD), review(HEAD, 'CHANGES_REQUESTED')] });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /requested changes/);
});

test('dismissal withdraws the approval', async (t) => {
  runtimeEnv(t, reviewWake());
  const { statuses } = stubFetch({ reviews: [review(HEAD, 'DISMISSED')] });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /no reviewer verdict/);
});

// — carried-forward approval on a head that only integrates fresh main (#979/#1742) —

const CARRY_FORK = 'a'.repeat(40);
const CARRY_APPROVED = 'b'.repeat(40);
const CARRY_INTEGRATED = 'c'.repeat(40);
const CARRY_OTHER = 'd'.repeat(40);
const carryTreeOf = (entries) => ({
  truncated: false,
  tree: Object.entries(entries).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })),
});
const CARRY_TREES = {
  // fork: a1 b1   approved: a2 b1   main-taken: a1 b2   landing (HEAD): a2 b2
  [CARRY_FORK]: carryTreeOf({ a: 'a1', b: 'b1' }),
  [CARRY_APPROVED]: carryTreeOf({ a: 'a2', b: 'b1' }),
  [CARRY_INTEGRATED]: carryTreeOf({ a: 'a1', b: 'b2' }),
  [HEAD]: carryTreeOf({ a: 'a2', b: 'b2' }),
};
const CARRY_COMPARES = {
  [`${HEAD}...main`]: { merge_base_commit: { sha: CARRY_INTEGRATED } },
  [`${CARRY_APPROVED}...${CARRY_INTEGRATED}`]: { merge_base_commit: { sha: CARRY_FORK } },
};
const carryStub = (overrides = {}) =>
  stubFetch({
    reviews: [review(CARRY_APPROVED, 'APPROVED', 7, LATE)],
    compares: CARRY_COMPARES,
    trees: CARRY_TREES,
    ...overrides,
  });

test('a head that only integrates fresh main carries the standing approval forward', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub();
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
  assert.match(statuses.at(-1).description, /only merges/);
  assert.match(statuses.at(-1).description, /review 7/);
});

test('a head that also carries its own change is never covered by the carry', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({ trees: { ...CARRY_TREES, [HEAD]: carryTreeOf({ a: 'a2', b: 'b2', c: 'c9' }) } });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /no reviewer verdict names head/);
});

test('a path the change and the base branch both moved conflicts, so nothing carries', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({
    trees: { ...CARRY_TREES, [CARRY_INTEGRATED]: carryTreeOf({ a: 'a3', b: 'b2' }) },
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('a truncated tree listing refuses the carry, never completes it', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({
    trees: { ...CARRY_TREES, [HEAD]: { ...carryTreeOf({ a: 'a2', b: 'b2' }), truncated: true } },
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('a later changes request on another head withdraws the standing approval, so nothing carries', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({
    reviews: [
      review(CARRY_APPROVED, 'APPROVED', 7, LATE),
      review(CARRY_OTHER, 'CHANGES_REQUESTED', 8, '2026-09-13T00:02:00Z'),
    ],
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('an unreadable compare leaves the gate red, never carried', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({ comparesFail: true });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('a pull request whose base ref cannot be read carries nothing', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({ base: null });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
});

test('a dismissal naming this exact head blocks the carry, even with an eligible approval elsewhere', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = carryStub({
    reviews: [review(CARRY_APPROVED, 'APPROVED', 7, LATE), review(HEAD, 'DISMISSED', 8, '2026-09-13T00:02:00Z')],
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /no reviewer verdict names head/);
});

test('unreadable review evidence leaves pending', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({ reviewStatus: 503 });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending'],
  );
});

test('a malformed newer review leaves pending, never a stale green', async (t) => {
  // The malformed entry discards the state filter's older approval; the gate
  // must fail closed on the unreadable inventory, not publish that approval.
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({
    reviews: [review(), { id: 2, commit_id: HEAD, user: { login: 'toddreviewer01' } }],
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending'],
  );
});

test('a head move during the review read publishes no stale verdict', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({ heads: [HEAD, OLD], reviews: [review()] });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending'],
  );
});

test('a CodeRabbit status is not a gate trigger', async (t) => {
  runtimeEnv(t, {
    context: 'CodeRabbit',
    sha: HEAD,
    sender: { login: 'coderabbitai[bot]' },
  });
  const { statuses, calls } = stubFetch();
  await main();
  assert.deepEqual(statuses, []);
  assert.deepEqual(calls, []);
});

test('a review/seat status is not a gate trigger (#2293)', async (t) => {
  runtimeEnv(t, { context: 'review/seat', sha: HEAD, sender: { login: 'toddreviewer01' } });
  const { statuses, calls } = stubFetch({ reviews: [review()] });
  await main();
  assert.deepEqual(statuses, []);
  assert.deepEqual(calls, []);
});

test('a stacked follow-on PR carrying the head in its history does not block resolution', async (t) => {
  runtimeEnv(t, reviewWake());
  const { statuses } = stubFetch({
    reviews: [review()],
    associated: [
      { number: 1, state: 'open', head: { sha: HEAD } },
      { number: 2, state: 'open', head: { sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
    ],
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
});

test('two open pull requests genuinely sharing the exact head still refuse', async (t) => {
  runtimeEnv(t, reviewWake());
  const { statuses } = stubFetch({
    associated: [
      { number: 1, state: 'open', head: { sha: HEAD } },
      { number: 2, state: 'open', head: { sha: HEAD } },
    ],
  });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(statuses.at(-1).description, /head belongs to 2 open pull requests/);
});

// — repository settings: the guarded surface and the Dependabot attestation —

test('absent settings are none; unknown keys, bad paths and unreadable files refuse', () => {
  const enoent = () => {
    throw Object.assign(new Error('no file'), { code: 'ENOENT' });
  };
  assert.deepEqual(readSettings(enoent), { guardedFiles: [], guardedEntryPoints: [], dependabot: false });
  const from = (text) => () => text;
  assert.deepEqual(readSettings(from('{"guardedFiles":["a/b.json"],"dependabot":true}')), {
    guardedFiles: ['a/b.json'],
    guardedEntryPoints: [],
    dependabot: true,
  });
  assert.throws(() => readSettings(from('{"guardedFile":["a"]}')), /unknown setting: guardedFile/);
  assert.throws(() => readSettings(from('{"guardedFiles":["../x"]}')), /repository-relative/);
  assert.throws(() => readSettings(from('{"guardedFiles":["/etc/x"]}')), /repository-relative/);
  assert.throws(() => readSettings(from('{"guardedEntryPoints":"a.mjs"}')), /repository-relative/);
  assert.throws(() => readSettings(from('{"dependabot":"yes"}')), /true or false/);
  assert.throws(() => readSettings(from('[]')), /not an object/);
  assert.throws(() => readSettings(from('{not json')), SyntaxError);
  assert.throws(
    () =>
      readSettings(() => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      }),
    /EACCES/,
  );
});

test('the closure follows static, re-exported and dynamic relative imports, and refuses an unreadable file', () => {
  const files = {
    'scripts/a.mjs':
      'import { b } from "./b.mjs";\nexport * from "./c.mjs";\nawait import("../lib/d.mjs");\nconst e = require("./e.cjs");\nimport x from "node:fs";\n// a comment mentioning import x from "./not-a-file.mjs"',
    'scripts/b.mjs': '',
    'scripts/c.mjs': '',
    'scripts/e.cjs': '',
    'lib/d.mjs': '',
  };
  let unreadable = false;
  const read = (file) => {
    if (file === 'scripts/b.mjs' && unreadable) throw new Error('EACCES');
    if (!(file in files)) throw Object.assign(new Error(`no ${file}`), { code: 'ENOENT' });
    return files[file];
  };
  assert.deepEqual(
    [...importClosure(['scripts/a.mjs'], read)].sort(),
    ['lib/d.mjs', 'scripts/a.mjs', 'scripts/b.mjs', 'scripts/c.mjs', 'scripts/e.cjs'],
  );
  assert.throws(() => importClosure(['scripts/missing.mjs'], read), /no scripts\/missing\.mjs/);
  unreadable = true;
  assert.throws(() => importClosure(['scripts/a.mjs'], read), /EACCES/);
  const surface = guardedSurface({ guardedFiles: ['ledger.json'], guardedEntryPoints: [], dependabot: false }, read);
  assert.deepEqual([...surface].sort(), ['.github/review-gate.json', 'ledger.json']);
});

test('a touch is found by name or by a rename away, and an unprovable list refuses', () => {
  const surface = new Set(['scripts/guarded.mjs']);
  assert.equal(guardedTouch([fileNamed('docs/x.md')], surface), null);
  assert.equal(
    guardedTouch([fileNamed('scripts/x.mjs', { status: 'renamed', previous_filename: 'scripts/guarded.mjs' })], surface),
    'scripts/guarded.mjs',
  );
  assert.throws(() => guardedTouch(null, surface), /unreadable/);
  assert.throws(
    () => guardedTouch(Array.from({ length: 3000 }, (_, i) => fileNamed(`f${i}`)), surface),
    /3000-file cap/,
  );
});

const SURFACE_CHECKOUT = {
  settings: { guardedFiles: ['scripts/ledger.json'], guardedEntryPoints: ['scripts/release.mjs'] },
  files: { 'scripts/release.mjs': "import './rule.mjs';\n", 'scripts/rule.mjs': '' },
};

test('a declared-ordinary change on the configured surface is guarded, whatever the lane says', async (t) => {
  runtimeEnv(t, pullEvent(), SURFACE_CHECKOUT);
  const touching = [fileNamed('scripts/rule.mjs')];
  const unreviewed = stubFetch({ lane: 'ordinary', files: touching });
  await main();
  assert.deepEqual(
    unreviewed.statuses.map(({ state }) => state),
    ['pending', 'failure'],
  );
  assert.match(unreviewed.statuses.at(-1).description, /^scripts\/rule\.mjs is guarded surface; guarded: no reviewer/);

  const approved = stubFetch({ lane: 'ordinary', files: touching, reviews: [review()] });
  await main();
  assert.equal(approved.statuses.at(-1).state, 'success');
  assert.match(approved.statuses.at(-1).description, /exact-head reviewer approval/);

  const elsewhere = stubFetch({ lane: 'ordinary', files: [fileNamed('docs/x.md')] });
  await main();
  assert.equal(elsewhere.statuses.at(-1).state, 'success');
});

test('the settings file is guarded surface even where a repository has none', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses } = stubFetch({ lane: 'ordinary', files: [fileNamed('.github/review-gate.json')] });
  await main();
  assert.equal(statuses.at(-1).state, 'failure');
  assert.match(statuses.at(-1).description, /review-gate\.json is guarded surface/);
});

test('an unreadable file list leaves an ordinary lane pending, never green', async (t) => {
  runtimeEnv(t, pullEvent(), SURFACE_CHECKOUT);
  const { statuses } = stubFetch({ lane: 'ordinary', fileStatus: 502 });
  await main();
  assert.deepEqual(
    statuses.map(({ state }) => state),
    ['pending'],
  );
});

test('unreadable or unknown settings publish nothing but pending, even for an approved head', async (t) => {
  for (const settings of ['{broken', '{"guardedFile":["x"]}']) {
    await t.test(settings, async (st) => {
      runtimeEnv(st, pullEvent(), { settings });
      const { statuses } = stubFetch({ lane: 'ordinary', reviews: [review()] });
      await main();
      assert.deepEqual(
        statuses.map(({ state }) => state),
        ['pending'],
      );
    });
  }
});

// A real Dependabot pull request, its commit list and its file list, captured from a public
// repository (each fixture's "source" says where). Variations are spread over the real reply.
const REAL_DEPENDABOT_PULL = readFixture('review-gate/dependabot-pull-actions-checkout-2590-pull.json');
const [REAL_DEPENDABOT_COMMIT] = readFixture('review-gate/dependabot-pull-actions-checkout-2590-commits.json');
const dependabotCommit = (overrides = {}) => ({ ...REAL_DEPENDABOT_COMMIT, ...overrides });
const dependabotPull = (overrides = {}) => ({ ...REAL_DEPENDABOT_PULL, ...overrides });

test('Dependabot attestation requires its identity, same-repository head, complete commits and signatures', () => {
  assert.equal(dependabotAttested(dependabotPull(), [dependabotCommit()]), true);
  const user = REAL_DEPENDABOT_PULL.user;
  assert.equal(dependabotAttested(dependabotPull({ user: { ...user, type: 'User' } }), [dependabotCommit()]), false);
  assert.equal(
    dependabotAttested(
      dependabotPull({ head: { ...REAL_DEPENDABOT_PULL.head, repo: { ...REAL_DEPENDABOT_PULL.head.repo, id: 12 } } }),
      [dependabotCommit()],
    ),
    false,
  );
  assert.equal(dependabotAttested(dependabotPull({ commits: 2 }), [dependabotCommit()]), false);
  assert.equal(
    dependabotAttested(dependabotPull(), [dependabotCommit({ author: { ...REAL_DEPENDABOT_COMMIT.author, id: 42 } })]),
    false,
  );
  const unverified = { ...REAL_DEPENDABOT_COMMIT.commit, verification: { ...REAL_DEPENDABOT_COMMIT.commit.verification, verified: false } };
  assert.equal(dependabotAttested(dependabotPull(), [dependabotCommit({ commit: unverified })]), false);
  // Someone else's signed commit claiming Dependabot as author: GitHub verifies the committer.
  assert.equal(
    dependabotAttested(dependabotPull(), [
      dependabotCommit({ committer: { ...REAL_DEPENDABOT_COMMIT.committer, login: 'someone', id: 42 } }),
    ]),
    false,
  );
  assert.equal(dependabotAttested(dependabotPull(), []), false);
});

test("an attested Dependabot change is green only where the repository's settings allow it", async (t) => {
  runtimeEnv(t, pullEvent(), { settings: { dependabot: true } });
  const allowed = stubFetch({ pull: dependabotPull(), commits: [dependabotCommit()] });
  await main();
  assert.equal(allowed.statuses.at(-1).state, 'success');
  assert.match(allowed.statuses.at(-1).description, /Dependabot's own attested change/);

  const mixed = stubFetch({
    pull: dependabotPull(),
    commits: [dependabotCommit({ author: { ...REAL_DEPENDABOT_COMMIT.author, id: 42 } })],
  });
  await main();
  assert.equal(mixed.statuses.at(-1).state, 'failure');

  const unreadable = stubFetch({ pull: dependabotPull(), commitStatus: 502 });
  await main();
  assert.deepEqual(
    unreadable.statuses.map(({ state }) => state),
    ['pending'],
  );
});

test('without the setting, a Dependabot change needs the reviewer like any other', async (t) => {
  runtimeEnv(t, pullEvent());
  const { statuses, calls } = stubFetch({ pull: dependabotPull(), commits: [dependabotCommit()] });
  await main();
  assert.equal(statuses.at(-1).state, 'failure');
  assert.equal(
    calls.some(([path]) => path.includes('/commits')),
    false,
  );
});
