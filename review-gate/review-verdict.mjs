#!/usr/bin/env node
// The one pure guarded-review rule. Callers read their own GitHub, Superset and
// process-table facts, then ask this module for their gate, wait and backstop
// projections. It never reaches those systems or writes a status/terminal.
//
// Its one editable home is todd-studio/ci-tools. The review gate fetches it at a
// pinned commit beside review-gate.mjs; todd-studio/workstation, whose ws and
// router import it at start, carries a byte-identical copy its CI checks against
// that pin's SHA-256. Change it here, then move the pins.
import { pathToFileURL } from 'node:url';

export const REVIEWER_LOGIN = 'toddreviewer01';
export const LAUNCH_MARKER = 'ws-review-launch';
export const MAX_ROUNDS = 5;
export const MAX_LAUNCHES_PER_ROUND = 3;
export const STUCK_MS = 30 * 60 * 1000;
export const EARLY_DEATH_MS = 60 * 1000;
export const LIVENESS_PATTERN = (repository, number) => `services/review-launch.mjs ${repository}#${number} `;

const FULL_SHA = /^[0-9a-f]{40}$/;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseLane(body) {
  const cleaned = (body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const lines = cleaned.split('\n').filter((candidate) => /^\s*-?\s*Lane\s*:/i.test(candidate));
  if (lines.length !== 1) return 'undeclared';
  const [line] = lines;
  const value = line.replace(/^[\s-]*Lane\s*:\s*/i, '').trim();
  const token = (value.match(/^([A-Za-z][A-Za-z-]*)/) ?? [])[1]?.toLowerCase();
  if (token === 'ordinary') return 'ordinary';
  if (token === 'guarded') return 'guarded';
  return 'undeclared';
}

function validTime(value) {
  if (typeof value !== 'string') return null;
  const match = RFC3339.exec(value);
  if (!match) return null;
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  const [, year, month, day, hour, minute, second, fraction = '', zone, sign, zoneHour, zoneMinute] = match;
  const offset = zone === 'Z' ? 0 : (sign === '+' ? 1 : -1) * (Number(zoneHour) * 60 + Number(zoneMinute));
  const local = new Date(at + offset * 60_000);
  return local.getUTCFullYear() === Number(year) &&
    local.getUTCMonth() + 1 === Number(month) &&
    local.getUTCDate() === Number(day) &&
    local.getUTCHours() === Number(hour) &&
    local.getUTCMinutes() === Number(minute) &&
    local.getUTCSeconds() === Number(second) &&
    local.getUTCMilliseconds() === Number(fraction.padEnd(3, '0'))
    ? at
    : null;
}

function normalizedReview(review, fallbackId = null) {
  const login = review?.user?.login ?? review?.author?.login;
  const head = review?.commit_id ?? review?.commit?.oid;
  const submittedAt = review?.submitted_at ?? review?.submittedAt;
  const id = review?.id ?? fallbackId;
  if (!Number.isSafeInteger(id) || id < 1 || typeof review?.state !== 'string' || typeof login !== 'string' || !login)
    throw new Error('the reviewer verdict inventory is unreadable');
  if (!(head === null || typeof head === 'string')) throw new Error('the reviewer verdict inventory is unreadable');
  return { id, state: review.state, login, head, submittedAt };
}

// The trusted gate receives REST reviews, where every entry must be complete
// before the verdict is reduced. The backstop's GraphQL-shaped list has no
// REST id, so its original list order supplies a tie-breaker only there.
export function readableReviews(reviews) {
  if (!Array.isArray(reviews)) throw new Error('the exact-head reviewer verdict inventory is unreadable');
  for (const review of reviews) {
    if (
      !review ||
      typeof review !== 'object' ||
      Array.isArray(review) ||
      !Number.isSafeInteger(review.id) ||
      review.id < 1 ||
      typeof review.state !== 'string' ||
      !(review.commit_id === null || typeof review.commit_id === 'string') ||
      typeof review.user?.login !== 'string' ||
      !review.user.login
    )
      throw new Error('the exact-head reviewer verdict inventory is unreadable');
  }
  return reviews;
}

export function reviewerDecisions(reviews, { strict = false } = {}) {
  if (!Array.isArray(reviews)) throw new Error('the pull request reviews are unreadable');
  if (strict) readableReviews(reviews);
  return reviews
    .map((review, index) => normalizedReview(review, index + 1))
    .filter(
      (review) =>
        review.login === REVIEWER_LOGIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
    )
    .map((review) => {
      const at = validTime(review.submittedAt);
      if (at === null) throw new Error('a reviewer decision has no readable submission time');
      return { ...review, at };
    })
    .sort((left, right) => left.at - right.at || left.id - right.id);
}

export function reviewerVerdict(reviews, head) {
  readableReviews(reviews);
  const decisions = reviewerDecisions(
    reviews.filter(
      (review) =>
        review.user.login === REVIEWER_LOGIN &&
        review.commit_id === head &&
        ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state),
    ),
  );
  const latest = decisions.at(-1) ?? null;
  if (!latest || latest.state === 'DISMISSED') return null;
  return { ok: latest.state === 'APPROVED', id: latest.id, submittedAt: latest.submittedAt };
}

export function priorReviewerVerdict(reviews, head) {
  const heads = new Set(
    reviewerDecisions(reviews, { strict: true })
      .filter((review) => typeof review.head === 'string' && review.head !== head && review.state !== 'DISMISSED')
      .map((review) => review.head),
  );
  let latest = null;
  for (const candidate of heads) {
    const verdict = reviewerVerdict(reviews, candidate);
    if (!verdict) continue;
    const at = Date.parse(verdict.submittedAt);
    const latestAt = latest ? Date.parse(latest.submittedAt) : -Infinity;
    if (at > latestAt || (at === latestAt && verdict.id > latest.id)) latest = { ...verdict, head: candidate };
  }
  return latest;
}

export function reviewerWithdrewOn(reviews, head) {
  return reviewerDecisions(reviews, { strict: true }).some(
    (review) => review.head === head && review.state === 'DISMISSED',
  );
}

export function launchRecords(comments) {
  if (!Array.isArray(comments)) throw new Error('the pull request comments are unreadable');
  const records = [];
  for (const comment of comments) {
    const found = new RegExp(`<!-- ${LAUNCH_MARKER} (\\{[^\\n]*\\}) -->`).exec(
      typeof comment?.body === 'string' ? comment.body : '',
    );
    if (!found) continue;
    let record;
    try {
      record = JSON.parse(found[1]);
    } catch {
      continue;
    }
    const at = validTime(record?.at);
    if (record?.v !== 1 || at === null) continue;
    records.push({ ...record, at });
  }
  return records.sort((left, right) => left.at - right.at);
}

function requestedReviewer(requests) {
  if (!Array.isArray(requests)) throw new Error('the requested-reviewer inventory is unreadable');
  return requests.some((request) => (request?.login ?? request?.name) === REVIEWER_LOGIN);
}

function latestRequestedAt(timeline) {
  if (!Array.isArray(timeline)) throw new Error('the review-request timeline is unreadable');
  const values = timeline
    .filter((event) => event?.event === 'review_requested' && event?.requested_reviewer?.login === REVIEWER_LOGIN)
    .map((event) => validTime(event.created_at))
    .filter((at) => at !== null);
  return values.length === 0 ? null : Math.max(...values);
}

function publishedGate(statuses) {
  if (!Array.isArray(statuses)) throw new Error('the commit-status inventory is unreadable');
  const row = statuses.find((status) => status?.context === 'review/gate');
  if (!row) return null;
  if (typeof row.state !== 'string') throw new Error('the review/gate status is unreadable');
  return { state: row.state, description: typeof row.description === 'string' ? row.description : '' };
}

function waitAnswer(outcome, next, reason, round, head, launches, reviewer) {
  return { outcome, next, reason, round, head, launches_this_round: launches.length, reviewer };
}

function backstopAnswer(action, reason) {
  return { action, reason };
}

export function evaluateReviewVerdict(input) {
  if (!input || typeof input !== 'object') throw new Error('the guarded-review state is unreadable');
  const pr = input.pullRequest;
  if (!pr || typeof pr !== 'object' || !Number.isSafeInteger(pr.number) || pr.number < 1)
    throw new Error('the pull request is unreadable');
  const state = String(pr.state ?? 'OPEN').toUpperCase();
  if (
    !['OPEN', 'MERGED', 'CLOSED'].includes(state) ||
    typeof pr.draft !== 'boolean' ||
    !FULL_SHA.test(String(pr.head ?? ''))
  )
    throw new Error('the pull request is unreadable');
  const lane = parseLane(pr.body);
  const decisions = reviewerDecisions(input.reviews, { strict: true });
  const launches = launchRecords(input.comments);
  const requested = requestedReviewer(input.reviewRequests);
  const requestedAt = latestRequestedAt(input.timeline);
  const gate = publishedGate(input.statuses);
  const now = input.now;
  const stuckMs = input.stuckMs ?? STUCK_MS;
  const earlyDeathMs = input.earlyDeathMs ?? EARLY_DEATH_MS;
  if (!Number.isFinite(now)) throw new Error('the verdict clock is unreadable');
  if (!Number.isFinite(stuckMs) || stuckMs < 0 || !Number.isFinite(earlyDeathMs) || earlyDeathMs < 0)
    throw new Error('the review timing policy is unreadable');
  if (
    !['working', 'idle', 'absent'].includes(input.author) ||
    !['live', 'dead', 'unknown', 'none'].includes(input.reviewer)
  )
    throw new Error('the reviewer liveness is unreadable');

  // The current-head reduction is independent of a newer review on an older
  // commit: GitHub can deliver those out of commit order, and only a decision
  // naming this exact head can approve, reject, or withdraw it.
  const latest = decisions.at(-1) ?? null;
  const current = decisions.filter((decision) => decision.head === pr.head).at(-1) ?? null;
  const review = current?.state === 'DISMISSED' ? null : current;
  const carried = input.carriedApproval && typeof input.carriedApproval === 'object' ? input.carriedApproval : null;
  const directApproval = review?.state === 'APPROVED';
  const directChanges = review?.state === 'CHANGES_REQUESTED';
  const satisfied = lane === 'ordinary' || directApproval || (!review && carried !== null);
  const gateProjection =
    lane === 'ordinary'
      ? { colour: 'success', description: 'ordinary: required CI is independently enforced' }
      : satisfied
        ? {
            colour: 'success',
            description: directApproval
              ? `guarded: exact-head reviewer approval is green (review ${review.id})`
              : 'guarded: main-only merge carries reviewer approval',
          }
        : directChanges
          ? {
              colour: 'failure',
              description: `guarded: reviewer requested changes on head ${pr.head.slice(0, 12)} (review ${review.id})`,
            }
          : {
              colour: 'failure',
              description: `${lane === 'undeclared' ? 'no readable Lane declaration (treated as guarded)' : 'guarded'}: no reviewer verdict names head ${pr.head.slice(0, 12)}`,
            };

  const round = decisions.length;
  const roundStart = latest?.at ?? validTime(pr.createdAt) ?? 0;
  const launchesThisRound = launches.filter((launch) => launch.at > roundStart && launch.failed !== true);
  const newest = launches.at(-1) ?? null;
  const newestSeated = launches.filter((launch) => launch.failed !== true).at(-1) ?? null;
  const start = `ws review start ${pr.number}`;
  let wait;
  if (state === 'MERGED')
    wait = waitAnswer('approved', 'done', 'the pull request merged', round, pr.head, launchesThisRound, input.reviewer);
  else if (state === 'CLOSED')
    wait = waitAnswer(
      'give-up',
      'the pull request is closed without a merge; reopen or refile before any further round',
      'closed without merging',
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (directApproval && gate?.state === 'failure')
    wait = waitAnswer(
      'gate-stale',
      'call again',
      `toddreviewer01 approved head ${pr.head} but review/gate still publishes failure (${gate.description || 'no description'}) — the gate run is being re-run so the verdict and the gate agree`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (directApproval)
    wait = waitAnswer(
      'approved',
      'done — the merge follows when every required check is green',
      `toddreviewer01 approved head ${pr.head}`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (gate?.state === 'success')
    wait = waitAnswer(
      'approved',
      'done — the merge follows when every required check is green',
      `review/gate is green on the current head: ${gate.description}`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (round >= MAX_ROUNDS)
    wait = waitAnswer(
      'give-up',
      'the pull request goes to Needs attention with the findings; no further round',
      `round ${round} was not an approval (limit ${MAX_ROUNDS})`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (directChanges)
    wait = waitAnswer(
      'changes',
      `fix the findings, push, then run: ${start}`,
      `toddreviewer01 requested changes on head ${pr.head} (round ${round})`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (!requested)
    wait = waitAnswer(
      'unrequested',
      `run: ${start}`,
      `no review is requested from toddreviewer01 on head ${pr.head} and no verdict names it`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (!newest)
    wait = waitAnswer(
      'reviewer-dead',
      `run: ${start}`,
      'no reviewer has been launched for this pull request',
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (input.reviewer === 'dead' && launchesThisRound.length >= MAX_LAUNCHES_PER_ROUND)
    wait = waitAnswer(
      'give-up',
      'the pull request goes to Needs attention; no further launch this round',
      `${launchesThisRound.length} reviewers were launched this round and every one died without a verdict (limit ${MAX_LAUNCHES_PER_ROUND})`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (input.reviewer === 'dead' && newest?.failed === true && newest.at > roundStart)
    wait = waitAnswer(
      'reviewer-dead',
      `run: ${start}`,
      `the ${newest.family} launch failed before it could prove readiness: ${newest.reason ?? 'no reason recorded'}; the family is not retried this round`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (input.reviewer === 'dead')
    wait = waitAnswer(
      'reviewer-dead',
      `run: ${start}`,
      (() => {
        const subject = newestSeated ?? newest;
        if (now - subject.at < earlyDeathMs)
          return `the ${subject.family} reviewer (terminal ${subject.terminal}) died within ${earlyDeathMs / 1000}s of launch, so the next family is tried`;
        if (subject.session !== null && subject.session !== undefined && subject.resumed !== true)
          return `the ${subject.family} reviewer (terminal ${subject.terminal}) died after reading began; its ${subject.family} session ${subject.session} is resumed first`;
        return `the ${subject.family} reviewer (terminal ${subject.terminal}) died after a resume, so the next family is tried`;
      })(),
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else if (requestedAt !== null && now - requestedAt >= stuckMs)
    wait = waitAnswer(
      'reviewer-stuck',
      `run: ${start} --fresh`,
      `no verdict ${Math.floor((now - requestedAt) / 60_000)} minutes after the review request (limit ${stuckMs / 60_000})`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );
  else
    wait = waitAnswer(
      'waiting',
      'call again',
      input.reviewer === 'unknown'
        ? 'the reviewer could not be observed on this Mac; waiting on the verdict'
        : `the ${newest.family} reviewer is alive and the verdict is pending`,
      round,
      pr.head,
      launchesThisRound,
      input.reviewer,
    );

  let backstop;
  if (state !== 'OPEN') backstop = backstopAnswer('ok', `the pull request is ${state.toLowerCase()}`);
  else if (pr.draft) backstop = backstopAnswer('ok', "a draft is still the lane's working surface");
  else if (lane === 'ordinary') backstop = backstopAnswer('ok', 'an ordinary lane needs no reviewer');
  else if (directApproval) {
    const recorded = launches.some((launch) => launch.at <= review.at && launch.failed !== true);
    backstop = recorded
      ? backstopAnswer('ok', 'approved on the current head by a recorded reviewer launch')
      : backstopAnswer(
          'attention',
          `${REVIEWER_LOGIN} approved head ${pr.head} with no reviewer launch on record before it`,
        );
  } else if (gate?.state === 'success')
    backstop = backstopAnswer('ok', `review/gate is green on the current head: ${gate.description}`);
  else if (round >= MAX_ROUNDS)
    backstop =
      input.author === 'absent'
        ? backstopAnswer('attention', `round ${round} was not an approval and no author terminal remains`)
        : backstopAnswer('ok', `round ${round} was not an approval; the author waits on it`);
  else {
    const owed = directChanges
      ? `the reviewer requested changes on head ${pr.head} and no fix has been pushed`
      : requested
        ? `a review is requested from ${REVIEWER_LOGIN} on head ${pr.head} with no verdict yet`
        : `head ${pr.head} has no reviewer verdict and no review request`;
    const stuck = requested && requestedAt !== null && now - requestedAt >= stuckMs;
    const owedNow =
      stuck && input.reviewer === 'live'
        ? `${owed}; the reviewer is alive but has answered nothing for ${Math.floor((now - requestedAt) / 60_000)} minutes`
        : owed;
    if (input.reviewer === 'live' && !stuck && !directChanges)
      backstop = backstopAnswer('ok', `${owed}; the reviewer is alive`);
    else if (input.author === 'working') backstop = backstopAnswer('ok', `${owedNow}; the author is working`);
    else if (input.author === 'idle') backstop = backstopAnswer('wake', `${owedNow}; the author's terminal is idle`);
    else
      backstop = backstopAnswer(
        'attention',
        `${owedNow}; no author terminal is left in the lane${input.reviewer === 'live' ? '' : ' and no reviewer is alive'}`,
      );
  }
  return { lane, decisions, launches, gate: gateProjection, wait, backstop };
}

function compactVerdictInput(state, { now, reviewer, author = 'working', stuckSeconds, earlyDeathSeconds }) {
  if (!state || typeof state !== 'object' || !Number.isFinite(now) || !FULL_SHA.test(String(state.head ?? '')))
    throw new Error('the review outcome is unreadable');
  if (!Array.isArray(state.decisions) || !Array.isArray(state.launches))
    throw new Error('the review outcome is unreadable');
  const stamp = (instant) => {
    if (typeof instant !== 'number' || !Number.isFinite(instant) || !Number.isInteger(instant))
      throw new Error('the review outcome is unreadable');
    const value = instant;
    return new Date(value > 100_000_000_000 ? value : value * 1000).toISOString();
  };
  return {
    pullRequest: {
      number: state.number,
      state: state.merged ? 'MERGED' : state.state,
      draft: false,
      head: state.head,
      body: `- Lane: ${state.lane ?? 'guarded'}`,
      createdAt: stamp(state.created_at ?? 0),
    },
    reviews: state.decisions.map((decision, index) => ({
      id: index + 1,
      state: decision.state,
      commit_id: decision.commit ?? decision.head,
      submitted_at: stamp(decision.at),
      user: { login: REVIEWER_LOGIN },
    })),
    reviewRequests: state.requested ? [{ login: REVIEWER_LOGIN }] : [],
    comments: state.launches.map((launch) => ({
      body: `<!-- ${LAUNCH_MARKER} ${JSON.stringify({ ...launch, at: stamp(launch.at) })} -->`,
    })),
    timeline:
      state.requested_at === null || state.requested_at === undefined
        ? []
        : [
            {
              event: 'review_requested',
              requested_reviewer: { login: REVIEWER_LOGIN },
              created_at: stamp(state.requested_at),
            },
          ],
    statuses: state.gate ? [{ context: 'review/gate', ...state.gate }] : [],
    carriedApproval: null,
    author,
    reviewer,
    now: now * 1000,
    stuckMs: (stuckSeconds ?? STUCK_MS / 1000) * 1000,
    earlyDeathMs: (earlyDeathSeconds ?? EARLY_DEATH_MS / 1000) * 1000,
  };
}

// `ws review wait` has its own compact GitHub read, but no verdict policy:
// it normalizes that read and returns the shared wait projection.
export function evaluateWaitOutcome(state, { now, reviewer, mode, stuckSeconds, earlyDeathSeconds }) {
  const input = compactVerdictInput(state, { now, reviewer, stuckSeconds, earlyDeathSeconds });
  const verdict = evaluateReviewVerdict(input);
  if (mode !== 'request') return verdict.wait;
  const round = verdict.decisions.length;
  const latest = verdict.decisions.at(-1) ?? null;
  if (input.pullRequest.state === 'MERGED')
    return { ...verdict.wait, outcome: 'done', next: 'stop', reason: 'the pull request merged' };
  if (input.pullRequest.state === 'CLOSED')
    return { ...verdict.wait, outcome: 'done', next: 'stop', reason: 'the pull request closed without merging' };
  if (latest?.head === input.pullRequest.head && latest.state === 'APPROVED')
    return { ...verdict.wait, outcome: 'done', next: 'stop', reason: 'the current head is approved' };
  if (round >= MAX_ROUNDS)
    return { ...verdict.wait, outcome: 'done', next: 'stop', reason: `round ${round} was the last one` };
  return state.requested && latest?.head !== input.pullRequest.head
    ? {
        ...verdict.wait,
        outcome: 'requested',
        next: `review head ${state.head} as round ${round + 1}`,
        reason: `a review is requested on head ${state.head}`,
      }
    : {
        ...verdict.wait,
        outcome: 'waiting',
        next: 'call again',
        reason: 'no review request is pending on a head you have not reviewed',
      };
}

// Backstop-only readers and projection. They live beside the verdict because
// the ten-minute job owns the process table and terminal reads, not a second
// interpretation of reviewer identity, launches, rounds, or the stuck limit.
const SEAT_ROW = /^\s*([0-9]+)\s+.*services\/review-launch\.mjs ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*) /;

export function seatScopes(pgrepOutput) {
  const seats = [];
  for (const line of String(pgrepOutput ?? '').split('\n')) {
    const found = SEAT_ROW.exec(line);
    if (found) seats.push({ pid: Number(found[1]), repository: found[2], number: Number(found[3]) });
  }
  return seats;
}

export function seatSweepDecision(state) {
  if (state === 'OPEN') return { action: 'hold', reason: 'the pull request is still open' };
  if (state === 'MERGED' || state === 'CLOSED')
    return { action: 'end', reason: `the pull request is ${state.toLowerCase()}` };
  throw new Error(`the pull request state is unreadable: ${String(state ?? 'none')}`);
}

export function authorLiveness({ terminals, lifecycles, reviewerTerminals }) {
  const excluded = new Set(reviewerTerminals ?? []);
  const own = (Array.isArray(terminals) ? terminals : []).filter((terminal) => !excluded.has(terminal?.terminalId));
  if (own.length === 0) return 'absent';
  const byTerminal = new Map(
    (Array.isArray(lifecycles) ? lifecycles : []).map((row) => [row?.terminalId, row?.lastEventType]),
  );
  return own.some((terminal) => byTerminal.get(terminal.terminalId) === 'Start') ? 'working' : 'idle';
}

export function backstopDecision({
  repository,
  number,
  head,
  lane,
  draft,
  state,
  decisions,
  requested,
  requestedAt = null,
  launches,
  gate = null,
  author,
  reviewer,
  now = Date.now(),
}) {
  if (state !== 'OPEN')
    return { repository, number, head, action: 'ok', reason: `the pull request is ${String(state).toLowerCase()}` };
  if (draft) return { repository, number, head, action: 'ok', reason: "a draft is still the lane's working surface" };
  if (lane === 'ordinary')
    return { repository, number, head, action: 'ok', reason: 'an ordinary lane needs no reviewer' };
  if (!FULL_SHA.test(String(head ?? ''))) throw new Error(`${repository}#${number} has no readable head`);
  const verdict = evaluateReviewVerdict(
    compactVerdictInput(
      {
        number,
        state,
        head,
        lane,
        created_at: Math.floor(now / 1000),
        decisions,
        requested,
        requested_at: Number.isFinite(requestedAt) ? Math.floor(requestedAt / 1000) : null,
        launches,
        gate,
      },
      { now: Math.floor(now / 1000), reviewer, author },
    ),
  );
  return { repository, number, head, ...verdict.backstop };
}

export const WAKE_TEXT = ({ repository, number, reason }) =>
  `Guarded review of ${repository}#${number} is unresolved: ${reason}. Run: ws review wait ${number} --repo ${repository} — and act on its next line.`;

async function main() {
  const mode = process.argv[2];
  if (mode === 'constants') {
    process.stdout.write(
      `${JSON.stringify({ reviewer: REVIEWER_LOGIN, launchMarker: LAUNCH_MARKER, maxRounds: MAX_ROUNDS, maxLaunches: MAX_LAUNCHES_PER_ROUND })}\n`,
    );
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  if (mode === 'lane') {
    process.stdout.write(`${parseLane(text)}\n`);
    return;
  }
  const input = JSON.parse(text);
  const result = mode === 'wait' ? evaluateWaitOutcome(input.state, input) : evaluateReviewVerdict(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
