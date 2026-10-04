import assert from 'node:assert/strict';
import test from 'node:test';

import { readFixture } from './helpers/fixtures.mjs';

import {
  authorLiveness,
  backstopDecision,
  evaluateWaitOutcome,
  launchRecords,
  LAUNCH_MARKER,
  reviewerDecisions,
  seatScopes,
  seatSweepDecision,
  WAKE_TEXT,
  evaluateReviewVerdict,
} from '../review-gate/review-verdict.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const OLD = '2222222222222222222222222222222222222222';
const NOW = Date.parse('2026-09-30T08:00:00Z');
const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();
const launch = (seconds, extra = {}) => ({
  v: 1,
  family: 'kimi',
  host: 'mac-main',
  workspace: 'ws-1',
  terminal: 't-1',
  session: 's-1',
  head: HEAD,
  resumed: false,
  at: NOW - seconds * 1000,
  ...extra,
});
const decision = (state, commit, seconds) => ({ state, commit, at: NOW - seconds * 1000 });
const base = {
  repository: 'o/r',
  number: 7,
  head: HEAD,
  lane: 'guarded',
  draft: false,
  state: 'OPEN',
  decisions: [],
  requested: true,
  launches: [],
  author: 'working',
  reviewer: 'dead',
  now: NOW,
};

test('launch records are read from the comment marker, oldest first, and malformed ones are skipped', () => {
  const records = launchRecords([
    {
      body: `Reviewer launched.\n\n<!-- ws-review-launch {"v":1,"family":"kimi","terminal":"t-2","at":"${ago(10)}"} -->`,
    },
    { body: 'prose only' },
    { body: '<!-- ws-review-launch {not json} -->' },
    { body: '<!-- ws-review-launch {"v":2,"at":"2026-09-30T00:00:00Z"} -->' },
    { body: `<!-- ws-review-launch {"v":1,"family":"codex","terminal":"t-1","at":"${ago(100)}"} -->` },
  ]);
  assert.deepEqual(
    records.map((record) => record.terminal),
    ['t-1', 't-2'],
  );
  assert.throws(() => launchRecords(null), /unreadable/);
});

test('reviewer decisions keep only toddreviewer01 verdicts with a readable time', () => {
  const decisions = reviewerDecisions([
    { author: { login: 'toddreviewer01' }, state: 'CHANGES_REQUESTED', commit: { oid: OLD }, submittedAt: ago(200) },
    { author: { login: 'coderabbitai[bot]' }, state: 'APPROVED', commit: { oid: HEAD }, submittedAt: ago(150) },
    { author: { login: 'toddreviewer01' }, state: 'COMMENTED', commit: { oid: HEAD }, submittedAt: ago(120) },
    { author: { login: 'toddreviewer01' }, state: 'APPROVED', commit: { oid: HEAD }, submittedAt: ago(100) },
  ]);
  assert.deepEqual(
    decisions.map((d) => d.state),
    ['CHANGES_REQUESTED', 'APPROVED'],
  );
});

test('author liveness ignores the reviewer terminals and reads Start as working', () => {
  const terminals = [{ terminalId: 'a' }, { terminalId: 'r' }];
  assert.equal(
    authorLiveness({ terminals, lifecycles: [{ terminalId: 'a', lastEventType: 'Start' }], reviewerTerminals: ['r'] }),
    'working',
  );
  assert.equal(
    authorLiveness({ terminals, lifecycles: [{ terminalId: 'a', lastEventType: 'Stop' }], reviewerTerminals: ['r'] }),
    'idle',
  );
  assert.equal(authorLiveness({ terminals, lifecycles: [], reviewerTerminals: ['r'] }), 'idle');
  assert.equal(
    authorLiveness({
      terminals: [{ terminalId: 'r' }],
      lifecycles: [{ terminalId: 'r', lastEventType: 'Start' }],
      reviewerTerminals: ['r'],
    }),
    'absent',
  );
});

test('an idle author with an unresolved round is woken; a working one is left alone', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  assert.equal(backstopDecision({ ...base, author: 'idle' }).action, 'wake');
  assert.equal(backstopDecision({ ...base, author: 'working' }).action, 'ok');
  const changes = backstopDecision({
    ...base,
    author: 'idle',
    decisions: [decision('CHANGES_REQUESTED', HEAD, 60)],
    requested: false,
  });
  assert.equal(changes.action, 'wake');
  assert.match(changes.reason, /requested changes on head/);
});

test('no author terminal and no live reviewer is Needs attention, never silence', () => {
  const gone = backstopDecision({ ...base, author: 'absent', reviewer: 'dead' });
  assert.equal(gone.action, 'attention');
  assert.match(gone.reason, /no author terminal is left/);
});

test('a live reviewer on a pending request means nothing is owed yet', () => {
  assert.equal(
    backstopDecision({ ...base, author: 'absent', reviewer: 'live', requestedAt: NOW - 60_000 }).action,
    'ok',
  );
  // but a live reviewer does not cover a changes request the author owes
  assert.equal(
    backstopDecision({
      ...base,
      author: 'absent',
      reviewer: 'live',
      decisions: [decision('CHANGES_REQUESTED', HEAD, 60)],
      requested: false,
    }).action,
    'attention',
  );
});

test('a live reviewer with no verdict thirty minutes after the request no longer covers an absent author (review finding 4)', () => {
  const stuck = backstopDecision({ ...base, author: 'absent', reviewer: 'live', requestedAt: NOW - 31 * 60_000 });
  assert.equal(stuck.action, 'attention');
  assert.match(stuck.reason, /answered nothing for 31 minutes/);
  assert.equal(
    backstopDecision({ ...base, author: 'idle', reviewer: 'live', requestedAt: NOW - 31 * 60_000 }).action,
    'wake',
  );
  assert.equal(
    backstopDecision({ ...base, author: 'working', reviewer: 'live', requestedAt: NOW - 31 * 60_000 }).action,
    'ok',
  );
});

test('a green review/gate on the current head (a carried approval) is ok whatever the author is doing (review finding 5)', () => {
  const carried = backstopDecision({
    ...base,
    author: 'absent',
    requested: false,
    gate: { state: 'success', description: 'main-only merge carries review 9' },
  });
  assert.equal(carried.action, 'ok');
  assert.match(carried.reason, /review\/gate is green/);
  assert.equal(
    backstopDecision({
      ...base,
      author: 'absent',
      requested: false,
      gate: { state: 'failure', description: 'no reviewer verdict' },
    }).action,
    'attention',
  );
});

test('an approval with no launch record before it is flagged; a recorded launch or the old seat marker clears it', () => {
  const approved = [decision('APPROVED', HEAD, 60)];
  const flagged = backstopDecision({ ...base, decisions: approved });
  assert.equal(flagged.action, 'attention');
  assert.match(flagged.reason, /no reviewer launch on record before it/);
  assert.equal(backstopDecision({ ...base, decisions: approved, launches: [launch(300)] }).action, 'ok');
  assert.equal(backstopDecision({ ...base, decisions: approved, launches: [launch(30)] }).action, 'attention');
  // A launch that failed before readiness seated no reviewer; it cannot vouch
  // for an approval either (#2363).
  assert.equal(
    backstopDecision({ ...base, decisions: approved, launches: [launch(300, { failed: true, session: null })] }).action,
    'attention',
  );
});

test('drafts, ordinary lanes and closed pull requests are skipped; an unreadable head refuses', () => {
  assert.equal(backstopDecision({ ...base, draft: true, author: 'absent' }).action, 'ok');
  assert.equal(backstopDecision({ ...base, lane: 'ordinary', author: 'absent' }).action, 'ok');
  assert.equal(backstopDecision({ ...base, state: 'MERGED', author: 'absent' }).action, 'ok');
  assert.throws(() => backstopDecision({ ...base, head: 'short' }), /no readable head/);
});

test('the round cap is attention only when no author remains', () => {
  const five = [1, 2, 3, 4, 5].map((n) => decision('CHANGES_REQUESTED', OLD, 600 - n * 60));
  assert.equal(backstopDecision({ ...base, decisions: five, author: 'idle' }).action, 'ok');
  assert.equal(backstopDecision({ ...base, decisions: five, author: 'absent' }).action, 'attention');
});

test('the wake text tells the author the one command to run', () => {
  assert.match(WAKE_TEXT({ repository: 'o/r', number: 7, reason: 'x' }), /ws review wait 7 --repo o\/r/);
});

test('seat scopes are parsed from pgrep lines and only a wrapper carrying a pull request seats one', () => {
  const out = [
    '18489 /opt/homebrew/bin/node /Users/todd/workstation-main-live/services/review-launch.mjs todd-studio/workstation#2465 65a1042c deadbeef kimi /tmp/x/ready.json',
    '99779 /opt/homebrew/bin/node /Users/todd/workstation-main-live/services/review-launch.mjs todd-studio/workstation#2462 e6e54404 kimi /tmp/y/ready.json',
    '44783 node /Users/todd/workstation-main-live/services/review-launch.mjs',
    '',
  ].join('\n');
  assert.deepEqual(seatScopes(out), [
    { pid: 18489, repository: 'todd-studio/workstation', number: 2465 },
    { pid: 99779, repository: 'todd-studio/workstation', number: 2462 },
  ]);
  // The editor-with-the-file-open case seats nothing, and an empty table (pgrep's
  // no-match exit 1) is no seats, not an unreadable one.
  assert.deepEqual(seatScopes('4123 zed /lane/services/review-launch.mjs'), []);
  assert.deepEqual(seatScopes(''), []);
  assert.deepEqual(seatScopes(null), []);
});

test('a seat ends only for a merged or closed pull request; anything unreadable refuses', () => {
  assert.deepEqual(seatSweepDecision('OPEN'), { action: 'hold', reason: 'the pull request is still open' });
  assert.deepEqual(seatSweepDecision('MERGED'), { action: 'end', reason: 'the pull request is merged' });
  assert.deepEqual(seatSweepDecision('CLOSED'), { action: 'end', reason: 'the pull request is closed' });
  assert.throws(() => seatSweepDecision(undefined), /state is unreadable/);
  assert.throws(() => seatSweepDecision('DRAFT'), /state is unreadable/);
});

const VERDICT_HEAD = '18beab14bb08d1fbf0565e93fd966fb2a8933275';
const VERDICT_OLD = '3930fbfcd43950e8bc701f7a4b5ad64dee8f2739';
const verdictState = (overrides = {}) => ({
  pullRequest: {
    number: 1,
    state: 'OPEN',
    draft: false,
    head: VERDICT_HEAD,
    body: '- Lane: guarded, safety gate',
    createdAt: '2026-10-03T06:00:00Z',
  },
  reviews: [],
  reviewRequests: [{ login: 'toddreviewer01' }],
  comments: [],
  timeline: [],
  statuses: [],
  carriedApproval: null,
  author: 'working',
  reviewer: 'dead',
  now: Date.parse('2026-10-03T08:00:00Z'),
  ...overrides,
});
const restReview = (head, reviewState, id = 1, submittedAt = '2026-10-03T07:00:00Z') => ({
  id,
  state: reviewState,
  commit_id: head,
  submitted_at: submittedAt,
  user: { login: 'toddreviewer01' },
});

test('a captured exact-head approval has one green, approved, provenance-aware verdict', () => {
  const reviews = readFixture('review-gate/pulls-1-reviews-approved.json');
  const result = evaluateReviewVerdict(
    verdictState({ pullRequest: { ...verdictState().pullRequest, head: reviews[0].commit_id }, reviews }),
  );
  assert.equal(result.gate.colour, 'success');
  assert.equal(result.wait.outcome, 'approved');
  assert.equal(result.backstop.action, 'attention');
});

test('a later old-head decision cannot void a captured exact-head approval', () => {
  const reviews = readFixture('review-gate/pulls-1-reviews-approved.json');
  const head = reviews[0].commit_id;
  const result = evaluateReviewVerdict(
    verdictState({
      pullRequest: { ...verdictState().pullRequest, head },
      reviews: [...reviews, restReview(VERDICT_OLD, 'CHANGES_REQUESTED', reviews[0].id + 1, '2026-10-03T08:00:00Z')],
    }),
  );
  assert.equal(result.gate.colour, 'success');
  assert.equal(result.wait.outcome, 'approved');
  assert.equal(result.backstop.action, 'attention');
});

test('a later old-head decision cannot make a later launch precede the exact-head approval', () => {
  const reviews = readFixture('review-gate/pulls-1-reviews-approved.json');
  const head = reviews[0].commit_id;
  const result = evaluateReviewVerdict(
    verdictState({
      pullRequest: { ...verdictState().pullRequest, head },
      reviews: [...reviews, restReview(VERDICT_OLD, 'CHANGES_REQUESTED', reviews[0].id + 1, '2026-09-30T07:00:00Z')],
      comments: [
        {
          body: `<!-- ${LAUNCH_MARKER} ${JSON.stringify({ v: 1, at: '2026-09-30T06:15:00Z' })} -->`,
        },
      ],
    }),
  );
  assert.equal(result.gate.colour, 'success');
  assert.equal(result.wait.outcome, 'approved');
  assert.equal(result.backstop.action, 'attention');
});

test('an older-head approval cannot satisfy any guarded projection', () => {
  const result = evaluateReviewVerdict(verdictState({ reviews: [restReview(VERDICT_OLD, 'APPROVED')] }));
  assert.equal(result.gate.colour, 'failure');
  assert.equal(result.wait.outcome, 'reviewer-dead');
  assert.equal(result.backstop.action, 'ok');
});

test('a carried approval is green while wait waits for the published gate', () => {
  const result = evaluateReviewVerdict(
    verdictState({
      reviews: [restReview(VERDICT_OLD, 'APPROVED')],
      carriedApproval: { review: 7, integrated: VERDICT_OLD },
    }),
  );
  assert.equal(result.gate.colour, 'success');
  assert.equal(result.wait.outcome, 'reviewer-dead');
  assert.equal(result.backstop.action, 'ok');
});

test('a gate stale after an exact approval remains a wait, not a false approval', () => {
  const result = evaluateReviewVerdict(
    verdictState({
      reviews: [restReview(VERDICT_HEAD, 'APPROVED')],
      statuses: [{ context: 'review/gate', state: 'failure', description: 'no reviewer verdict' }],
    }),
  );
  assert.equal(result.gate.colour, 'success');
  assert.equal(result.wait.outcome, 'gate-stale');
  assert.equal(result.backstop.action, 'attention');
});

test('four unresolved rounds remain resumable until the shared fifth-round cap', () => {
  const reviews = [1, 2, 3, 4].map((id) =>
    restReview(VERDICT_OLD, 'CHANGES_REQUESTED', id, `2026-10-03T07:0${id}:00Z`),
  );
  const result = evaluateReviewVerdict(verdictState({ reviews }));
  assert.equal(result.wait.outcome, 'reviewer-dead');
  assert.equal(result.backstop.action, 'ok');
});

test('the wait command adapter returns the common wait projection from its compact GitHub read', () => {
  const result = evaluateWaitOutcome(
    {
      number: 1,
      state: 'OPEN',
      head: VERDICT_HEAD,
      created_at: Math.floor(Date.parse('2026-10-03T06:00:00Z') / 1000),
      decisions: [],
      launches: [],
      requested: true,
      requested_at: null,
      gate: null,
    },
    { now: Math.floor(Date.parse('2026-10-03T08:00:00Z') / 1000), reviewer: 'dead', mode: 'verdict' },
  );
  assert.equal(result.outcome, 'reviewer-dead');
});

test('the compact wait adapter rejects an absent or null decision timestamp', () => {
  const state = {
    number: 1,
    state: 'OPEN',
    head: VERDICT_HEAD,
    created_at: Math.floor(Date.parse('2026-10-03T06:00:00Z') / 1000),
    decisions: [{ state: 'APPROVED', commit: VERDICT_HEAD, at: null }],
    launches: [],
    requested: true,
    requested_at: null,
    gate: null,
  };
  assert.throws(
    () => evaluateWaitOutcome(state, { now: Math.floor(Date.parse('2026-10-03T08:00:00Z') / 1000), reviewer: 'dead' }),
    /unreadable/,
  );
  delete state.decisions[0].at;
  assert.throws(
    () => evaluateWaitOutcome(state, { now: Math.floor(Date.parse('2026-10-03T08:00:00Z') / 1000), reviewer: 'dead' }),
    /unreadable/,
  );
});

test('a missing lane declaration remains guarded and wakes an idle author', () => {
  const result = evaluateReviewVerdict(
    verdictState({ pullRequest: { ...verdictState().pullRequest, body: null }, author: 'idle' }),
  );
  assert.equal(result.gate.colour, 'failure');
  assert.equal(result.wait.outcome, 'reviewer-dead');
  assert.equal(result.backstop.action, 'wake');
});
