import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readFixture } from './helpers/fixtures.mjs';

import {
  authorLiveness,
  backstopDecision,
  evaluateWaitOutcome,
  evaluateRecoveryCleanup,
  launchRecords,
  LAUNCH_MARKER,
  parseLane,
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

test('literal Blacksmith footer appends preserve lane verdicts', () => {
  // Start with workstation's review-gate skip matrix, keeping only accepted footer appends.
  const bodies = [
    'A body\n\n- Lane: ordinary\n',
    'A body\n\n- Lane: guarded\n',
    'A body without a lane line\n',
    'Lane inside a comment\n<!-- - Lane: ordinary -->\n',
    'Unclosed comment swallows the append\n<!-- trailing\n',
    'A body\n\n- Lane: ordinary<!--\n',
    'A body\n\n- Lane: guarded <!-- note\n',
    'A body\n\n- Lane: ordinary\n- Lane: guarded\n',
    'Prose mentions `<!-- codesmith:footer -->` before the lane\n- Lane: ordinary\n',
    '- Lane: guarded\n<!-- codesmith:footer -->\n- Lane: ordinary\n',
  ];
  const appends = [
    '\n<!-- codesmith:footer -->\n---\n<img alt="[code]smith">\n<!-- /codesmith:footer -->\n',
    '\n<!-- codesmith:footer -->\n- Lane: guarded\n',
    '\n<!-- codesmith:footer -->\n- Lane: ordinary\n',
    '\n<!-- CODESMITH:FOOTER -->\n-->-extra\n- Lane: ordinary\n',
  ];
  for (const from of bodies) {
    for (const append of appends) {
      assert.equal(parseLane(from + append), parseLane(from), JSON.stringify({ from, append }));
    }
  }
});

test('only a standalone footer marker ends the exactly-one declaration region', () => {
  const cases = [
    ['Prose mentions `<!-- codesmith:footer -->`\n- Lane: ordinary\n', 'ordinary'],
    ['<!-- codesmith:footer -->-extra\n- Lane: guarded\n', 'guarded'],
    ['- Lane: guarded\n \t<!-- CoDeSmItH:FoOtEr --> \r\n- Lane: ordinary\n', 'guarded'],
    ['- Lane: ordinary\n<!-- codesmith:footer -->\n- Lane: guarded\n<!-- codesmith:footer -->\n', 'ordinary'],
    ['<!-- codesmith:footer -->\n- Lane: ordinary\n', 'undeclared'],
    ['<!-- codesmith:footer -->', 'undeclared'],
    ['- Lane: ordinary\n- Lane: guarded\n<!-- codesmith:footer -->\n', 'undeclared'],
    ['<!-- unclosed\n<!-- codesmith:footer -->\n-->\n- Lane: ordinary\n', 'undeclared'],
  ];
  for (const [body, expected] of cases) assert.equal(parseLane(body), expected, body);
});

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

test('an approval needs a successful launch for its head before it', () => {
  const approved = [decision('APPROVED', HEAD, 60)];
  const flagged = backstopDecision({ ...base, decisions: approved });
  assert.equal(flagged.action, 'attention');
  assert.match(flagged.reason, /no reviewer launched or re-requested for that head before it/);
  assert.equal(backstopDecision({ ...base, decisions: approved, launches: [launch(300)] }).action, 'ok');
  assert.equal(backstopDecision({ ...base, decisions: approved, launches: [launch(30)] }).action, 'attention');
  // A launch that failed before readiness seated no reviewer; it cannot vouch
  // for an approval either (#2363).
  assert.equal(
    backstopDecision({ ...base, decisions: approved, launches: [launch(300, { failed: true, session: null })] }).action,
    'attention',
  );
});

test('an approval with only an older-head launch is flagged', () => {
  const result = backstopDecision({
    ...base,
    decisions: [decision('APPROVED', HEAD, 60)],
    launches: [launch(300, { head: OLD })],
  });
  assert.equal(result.action, 'attention');
  assert.match(result.reason, /no reviewer launched or re-requested for that head before it/);
});

test('a re-request for the approved head after an older-head launch clears provenance', () => {
  const result = backstopDecision({
    ...base,
    decisions: [decision('APPROVED', HEAD, 60)],
    launches: [launch(300, { head: OLD })],
    requests: [{ v: 1, head: HEAD, at: NOW - 120_000 }],
  });
  assert.equal(result.action, 'ok');
  assert.match(result.reason, /reviewer re-requested for that head/);
});

test('a re-request without a seated launch before it cannot vouch for an approval', () => {
  for (const launches of [[], [launch(300, { head: OLD, failed: true })], [launch(90, { head: OLD })]]) {
    const result = backstopDecision({
      ...base,
      decisions: [decision('APPROVED', HEAD, 60)],
      launches,
      requests: [{ v: 1, head: HEAD, at: NOW - 120_000 }],
    });
    assert.equal(result.action, 'attention');
  }
});

test('a re-request after the approval cannot vouch for that approval', () => {
  const result = backstopDecision({
    ...base,
    decisions: [decision('APPROVED', HEAD, 60)],
    launches: [launch(300, { head: OLD })],
    requests: [{ v: 1, head: HEAD, at: NOW - 30_000 }],
  });
  assert.equal(result.action, 'attention');
});

test('the constants command publishes both provenance markers', () => {
  const constants = JSON.parse(
    execFileSync(process.execPath, [fileURLToPath(new URL('../review-gate/review-verdict.mjs', import.meta.url)), 'constants'], {
      encoding: 'utf8',
    }),
  );
  assert.equal(constants.launchMarker, 'ws-review-launch');
  assert.equal(constants.requestMarker, 'ws-review-request');
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
          body: `<!-- ${LAUNCH_MARKER} ${JSON.stringify({ v: 1, head, at: '2026-09-30T06:15:00Z' })} -->`,
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

test('unknown trusted-reviewer states refuse both REST and GraphQL decision inventories', () => {
  const [approval] = readFixture('review-gate/pulls-1-reviews-approved.json');
  const unknown = { ...approval, id: approval.id + 1, state: 'UNKNOWN' };
  assert.throws(() => reviewerDecisions([approval, unknown], { strict: true }), /inventory/);
  const graphql = (review) => ({
    author: review.user,
    state: review.state,
    commit: { oid: review.commit_id },
    submittedAt: review.submitted_at,
  });
  assert.throws(() => reviewerDecisions([approval, unknown].map(graphql)), /inventory/);
});

test('known non-decisive trusted reviews preserve an approval', () => {
  const [approval] = readFixture('review-gate/pulls-1-reviews-approved.json');
  for (const state of ['COMMENTED', 'PENDING']) {
    const reviews = [approval, { ...approval, id: approval.id + 1, state }];
    assert.deepEqual(reviewerDecisions(reviews, { strict: true }).map((review) => review.state), ['APPROVED']);
  }
});

// Live captures: VC1041 had no reviews after merge; CI25 received a native
// exact-head reviewer approval 41 seconds after merge (see review html_url).
const mergedCapture = readFixture('review-gate/merged-vc1041.json');
const mergedState = (extra = {}) => ({
  ...mergedCapture,
  created_at: Date.parse(mergedCapture.created_at) / 1000,
  decisions: [], launches: [], requested: false, requested_at: null,
  gate: { state: 'success', description: 'CI-only' }, ...extra,
});
const recoveryOptions = { now: Date.parse('2026-11-07T14:00:00Z') / 1000, reviewer: 'dead', recovery: true };

test('merged workflow completion is distinct from independent approval with explicit recovery', () => {
  assert.equal(evaluateWaitOutcome(mergedState(), { ...recoveryOptions, recovery: false, workflowCompletion: true }).outcome, 'done');
  // Published consumers retain the previous default until opting in.
  assert.equal(evaluateWaitOutcome(mergedState(), { ...recoveryOptions, recovery: false }).outcome, 'approved');
  assert.equal(evaluateWaitOutcome(mergedState(), recoveryOptions).outcome, 'unrequested');
  assert.equal(evaluateWaitOutcome(mergedState({ merged: false, state: 'CLOSED' }), recoveryOptions).outcome, 'give-up');
});

test('recovery requires an actual native exact-head verdict and ignores gate failure after approval', () => {
  const captured = readFixture('review-gate/merged-ci25-approval.json');
  const state = mergedState({ head: captured.commit_id, decisions: [{ state: captured.state, commit: captured.commit_id, at: Date.parse(captured.submitted_at) / 1000 }], gate: { state: 'failure' } });
  assert.equal(evaluateWaitOutcome(state, recoveryOptions).outcome, 'approved');
  assert.equal(evaluateWaitOutcome({ ...state, head: mergedCapture.head }, recoveryOptions).outcome, 'unrequested');
  assert.equal(evaluateWaitOutcome({ ...state, decisions: [{ ...state.decisions[0], state: 'CHANGES_REQUESTED' }] }, recoveryOptions).outcome, 'changes');
});

test('recovery uses its launch request and keeps native request, time and launch budgets bounded', () => {
  const launch = { v: 1, recovery: true, head: mergedCapture.head, family: 'kimi', terminal: 't', at: recoveryOptions.now - 60 };
  const state = mergedState({ launches: [launch] });
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, reviewer: 'live' }).outcome, 'waiting');
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, mode: 'request' }).outcome, 'requested');
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, mode: 'request', recovery: false }).outcome, 'done');
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, reviewer: 'live', now: recoveryOptions.now + 1800 }).outcome, 'reviewer-stuck');
  assert.equal(evaluateWaitOutcome({ ...state, launches: [launch, launch, launch] }, recoveryOptions).outcome, 'give-up');
});

test('shared cleanup covers startup intent, correlated seat and bounded failure cleanup', () => {
  const approval = readFixture('review-gate/merged-ci25-approval.json');
  const now = Date.parse(approval.submitted_at) - 1000;
  const intent = { v: 1, recovery: true, attempt: 'attempt-1', head: approval.commit_id, host: 'mac-main', workspace: 'ws', at: new Date(now - 60_000).toISOString() };
  const comment = (marker, record) => ({ body: `<!-- ${marker} ${JSON.stringify(record)} -->` });
  const request = (extra = {}) => comment('ws-review-request', { ...intent, ...extra });
  const launched = (extra = {}) => comment('ws-review-launch', { ...intent, family: 'kimi', terminal: 't', at: new Date(now - 30_000).toISOString(), ...extra });
  const input = { pullRequest: { state: 'MERGED', head: approval.commit_id }, reviews: [], comments: [request()], now };
  const action = (extra = {}) => evaluateRecoveryCleanup({ ...input, ...extra }).action;
  assert.equal(action(), 'hold'); // before terminal creation or readiness
  assert.equal(action({ comments: [request(), launched()] }), 'hold');
  for (const extra of [{ recovery: false }, { head: OLD }, { at: new Date(now + 1).toISOString() }, { at: new Date(now - 1800_000).toISOString() }])
    assert.equal(action({ comments: [request(extra)] }), 'reclaim');
  assert.equal(action({ comments: [request(), launched({ failed: true })] }), 'reclaim');
  assert.equal(action({ comments: [request(), launched({ failed: true, attempt: 'old-attempt' })] }), 'hold');
  assert.equal(action({ comments: [request({ at: new Date(now - 1800_000).toISOString() }), launched()] }), 'reclaim');
  assert.equal(action({ comments: [request(), launched(), launched(), launched(), launched()] }), 'reclaim');
  assert.equal(action({ comments: [request(), launched({ failed: true }), request({ attempt: 'attempt-2', at: new Date(now - 1000).toISOString() })] }), 'hold');
  assert.equal(action({ pullRequest: { ...input.pullRequest, state: 'CLOSED' } }), 'reclaim');
  assert.equal(action({ pullRequest: { state: 'OPEN' } }), 'hold');
  assert.equal(action({ reviews: [approval], now: now + 2000 }), 'reclaim');
  assert.equal(action({ reviews: [{ ...approval, commit_id: OLD }], now: now + 2000 }), 'hold');
  assert.equal(action({ reviews: [{ ...approval, user: { login: 'toddagent01' } }], now: now + 2000 }), 'hold');
  assert.equal(action({ reviews: [{ ...approval, state: 'CHANGES_REQUESTED' }], now: now + 2000 }), 'reclaim');
  assert.throws(() => action({ reviews: null }), /unreadable/);
});

test('recovery request mode stops on exact-head verdict, withdrawal stays pending, and timeout stops the seat', () => {
  const launch = { v: 1, recovery: true, head: mergedCapture.head, at: recoveryOptions.now - 60 };
  const state = mergedState({ launches: [launch] });
  const approval = { state: 'APPROVED', commit: mergedCapture.head, at: recoveryOptions.now - 10 };
  const old = { state: 'CHANGES_REQUESTED', commit: OLD, at: recoveryOptions.now - 5 };
  assert.equal(evaluateWaitOutcome({ ...state, decisions: [approval, old] }, { ...recoveryOptions, mode: 'request' }).outcome, 'done');
  assert.equal(evaluateWaitOutcome({ ...state, decisions: [{ ...approval, state: 'DISMISSED' }] }, { ...recoveryOptions, mode: 'request' }).outcome, 'requested');
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, mode: 'request', now: recoveryOptions.now + 1800 }).outcome, 'done');
  assert.throws(() => evaluateWaitOutcome({ ...state, launches: [{ ...launch, at: recoveryOptions.now + 1 }] }, recoveryOptions), /future/);
});

test('recovery request mode works during startup before any launch or GitHub review request', () => {
  const intent = { v: 1, recovery: true, attempt: 'startup', head: mergedCapture.head, host: 'mac-main', workspace: 'ws', at: recoveryOptions.now - 60 };
  const state = mergedState({ requests: [intent] });
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, mode: 'request' }).outcome, 'requested');
  assert.equal(evaluateWaitOutcome(state, { ...recoveryOptions, mode: 'request', now: recoveryOptions.now + 1800 }).outcome, 'done');
});

test('cleanup accepts the actual gh pr view review shape with GraphQL node IDs', () => {
  const approval = readFixture('review-gate/merged-ci25-approval-graphql.json');
  assert.equal(evaluateRecoveryCleanup({
    pullRequest: { state: 'MERGED', head: approval.commit.oid },
    reviews: [approval], comments: [], now: Date.parse(approval.submittedAt) + 1000,
  }).action, 'reclaim');
});
