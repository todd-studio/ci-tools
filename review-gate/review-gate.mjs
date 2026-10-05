#!/usr/bin/env node
// Publishes review/gate from trusted default-branch code. Branch protection
// owns required CI. This gate owns only the lane consequence: ordinary needs
// no reviewer; guarded (including an unreadable declaration) needs
// toddreviewer01's standing native approval of the exact current head.
// Review prose and third-party review services are never inputs.
//
// One gate for every repository that requires review/gate: each fetches this
// file and review-verdict.mjs from todd-studio/ci-tools at a pinned commit,
// SHA-256 checked, and runs it from its own default-branch checkout. What
// differs between repositories is a setting, never a fork: SETTINGS_PATH in
// that checkout (see readSettings).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  evaluateReviewVerdict,
  parseLane,
  priorReviewerVerdict,
  readableReviews,
  reviewerVerdict,
  reviewerWithdrewOn,
} from './review-verdict.mjs';

// Kept as the gate's public compatibility surface while the verdict module
// owns the declaration and reviewer-decision grammars for all three callers.
export { parseLane, priorReviewerVerdict, readableReviews, reviewerVerdict, reviewerWithdrewOn };

const FULL_SHA = /^[0-9a-f]{40}$/;

// The repository's own settings, read from the trusted default-branch
// checkout the workflow runs in — never from the pull request. Absent means
// none (the workstation shape). Present but unreadable, malformed or carrying
// a key this gate does not know is a refusal: the caller publishes nothing, and
// an absent or pending required context blocks.
//   guardedFiles        paths a declared-ordinary change may not touch unreviewed
//   guardedEntryPoints  modules whose whole relative-import closure joins them
//   dependabot          Dependabot's own attested change needs no reviewer
//   ciOnly              a readable lane declaration needs no reviewer
// The settings file is always on the guarded surface itself, so loosening or
// deleting it is never an ordinary change.
export const SETTINGS_PATH = '.github/review-gate.json';
const SETTING_KEYS = new Set(['guardedFiles', 'guardedEntryPoints', 'dependabot', 'ciOnly']);

const repositoryPath = (value) =>
  typeof value === 'string' &&
  value.length > 0 &&
  !value.startsWith('/') &&
  path.posix.normalize(value) === value &&
  !value.split('/').includes('..');

export function readSettings(read) {
  let text;
  try {
    text = read(SETTINGS_PATH);
  } catch (error) {
    if (error?.code === 'ENOENT') return { guardedFiles: [], guardedEntryPoints: [], dependabot: false, ciOnly: false };
    throw error;
  }
  const settings = JSON.parse(text);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error(`${SETTINGS_PATH} is not an object`);
  for (const key of Object.keys(settings))
    if (!SETTING_KEYS.has(key)) throw new Error(`${SETTINGS_PATH} names an unknown setting: ${key}`);
  const paths = (key) => {
    const value = settings[key] ?? [];
    if (!Array.isArray(value) || !value.every(repositoryPath))
      throw new Error(`${SETTINGS_PATH}: ${key} must be a list of repository-relative paths`);
    return value;
  };
  const dependabot = settings.dependabot ?? false;
  if (typeof dependabot !== 'boolean') throw new Error(`${SETTINGS_PATH}: dependabot must be true or false`);
  const ciOnly = settings.ciOnly ?? false;
  if (typeof ciOnly !== 'boolean') throw new Error(`${SETTINGS_PATH}: ciOnly must be true or false`);
  return { guardedFiles: paths('guardedFiles'), guardedEntryPoints: paths('guardedEntryPoints'), dependabot, ciOnly };
}

// Every repository file reachable from `entries` through relative import,
// re-export, dynamic-import or `require` specifiers, entries included, read
// from the trusted checkout — so a configured surface grows with the code: a
// new dependency joins it only by being imported from a file already on it,
// and that change is itself guarded. `read` returns a file's text or throws.
// A specifier naming no file there is text that looks like an import (a
// comment, a fixture string) and is skipped — so is an extensionless or
// directory-index specifier, which Node would resolve and this does not: keep
// imports on the surface spelled as exact file paths. Any other read failure,
// and a missing entry point, refuses the whole answer rather than shrinking it.
export function importClosure(entries, read) {
  const seen = new Set();
  const pending = entries.map((file) => ({ file, isEntry: true }));
  while (pending.length > 0) {
    const { file, isEntry } = pending.pop();
    if (seen.has(file)) continue;
    let text;
    try {
      text = read(file);
    } catch (error) {
      if (!isEntry && error?.code === 'ENOENT') continue;
      throw error;
    }
    seen.add(file);
    for (const [, specifier] of text.matchAll(/\b(?:from|import|require)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      pending.push({
        file: path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)),
        isEntry: false,
      });
    }
  }
  return seen;
}

export function guardedSurface(settings, read) {
  return new Set([SETTINGS_PATH, ...settings.guardedFiles, ...importClosure(settings.guardedEntryPoints, read)]);
}

// GitHub's pull-request files endpoint lists at most 3,000 files; a list that
// long may be truncated, so it cannot prove a path absent.
export const FILE_LIST_CAP = 3000;

export function guardedTouch(files, surface) {
  if (!Array.isArray(files)) throw new Error('the pull-request file list is unreadable');
  if (files.length >= FILE_LIST_CAP) throw new Error(`the pull-request file list reached GitHub's ${FILE_LIST_CAP}-file cap`);
  for (const file of files) {
    for (const name of [file?.filename, file?.previous_filename].filter(Boolean)) {
      if (surface.has(name)) return name;
    }
  }
  return null;
}

// Dependabot's own change, attested by GitHub rather than claimed: its app
// identity, a same-repository head, and every commit (the complete list)
// authored by it, committed by GitHub's web-flow and signature-verified.
// GitHub verifies the COMMITTER's signature, so authorship alone is a claim
// anyone pushing to the branch could make with their own signed commit; every
// Dependabot commit measured (16 plates-web pull requests, 2026-10-05) is
// committed by web-flow.
export const DEPENDABOT_ID = 49699333;
export const WEB_FLOW_ID = 19864447;

export function dependabotAttested(pullRequest, commits) {
  if (pullRequest?.user?.id !== DEPENDABOT_ID || pullRequest?.user?.type !== 'Bot') return false;
  const headRepository = pullRequest?.head?.repo?.id;
  if (typeof headRepository !== 'number' || headRepository !== pullRequest?.base?.repo?.id) return false;
  if (!Array.isArray(commits) || commits.length === 0 || commits.length !== pullRequest?.commits) return false;
  return commits.every(
    (commit) =>
      commit?.author?.id === DEPENDABOT_ID &&
      commit?.committer?.id === WEB_FLOW_ID &&
      commit?.commit?.verification?.verified === true,
  );
}

// A recursive git tree reduced to the one fact a three-way merge needs:
// path -> "<mode> <type> <sha>". Directory entries are dropped because a tree's
// own SHA is derived from the blobs below it, so comparing both would ask the
// same question twice and answer it differently under a rename. A listing
// GitHub TRUNCATED is not a tree at all — the entries it dropped are exactly
// the differences this must never read as agreement — so it throws rather than
// returning a short answer, and every caller turns that into a red gate.
export function treeIndex(tree) {
  if (!tree || typeof tree !== 'object') throw new Error('a tree listing is not an object');
  if (tree.truncated === true) throw new Error('a tree listing was truncated by GitHub');
  if (!Array.isArray(tree.tree)) throw new Error('a tree listing carries no entries');
  const index = new Map();
  for (const entry of tree.tree) {
    const readable = ['path', 'mode', 'type', 'sha'].every(
      (field) => typeof entry?.[field] === 'string' && entry[field].length > 0,
    );
    if (!readable) throw new Error('a tree entry is not readable');
    if (entry.type === 'tree') continue;
    if (index.has(entry.path)) throw new Error(`a tree lists ${entry.path} twice`);
    index.set(entry.path, `${entry.mode} ${entry.type} ${entry.sha}`);
  }
  return index;
}

// git's three-way merge, restricted to whole-path resolution: a path both sides
// changed differently is a conflict HERE even where git would blend the hunks
// and commit a clean result. That direction is deliberate. This decides whether
// a head is nothing but an integration of the base branch, and "git could have
// blended these" is not that — it is new content in the merge, which is the one
// thing a carried approval may never cover. Renames are not detected either,
// for the same reason: git's result then differs from this one, the trees
// disagree, and the carry is refused.
export function mergeTreeIndex(base, ours, theirs) {
  const merged = new Map();
  for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let take;
    if (o === t) take = o;
    else if (o === b) take = t;
    else if (t === b) take = o;
    else return null;
    if (take !== undefined) merged.set(path, take);
  }
  return merged;
}

export function treeIndexesEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) if (b.get(path) !== entry) return false;
  return true;
}

// The whole carry-forward claim, decided on TREES alone: the tree `landing`
// will produce is exactly `approved` integrated with whatever of the base
// branch `taken` already represents, and nothing else. Every argument is a raw
// GitHub tree listing (`GET .../git/trees/<sha>?recursive=1`); treeIndex's
// throws on a truncated or unreadable listing propagate out of this function
// too, and every caller must read that as a refusal — an uncertain tree is
// never read as an equal one. `base` is the fork point the approved head and
// the integrated base commit share, never a parent link, so repeated
// integrations describe one approved change integrated up to one base commit
// rather than a chain that must be walked hop by hop.
export function treesCarryApproval({ base, approved, taken, landing }) {
  const merged = mergeTreeIndex(treeIndex(base), treeIndex(approved), treeIndex(taken));
  return merged !== null && treeIndexesEqual(merged, treeIndex(landing));
}

// The carry-forward itself (#979, woken by #1742): a head with no exact-head
// reviewer verdict inherits the reviewer's latest APPROVED verdict from
// elsewhere in the pull request when this head's tree is provably nothing but
// that approved tree with the base branch merged into it. Every uncertainty —
// no eligible prior approval, an unreadable base ref, an unreadable
// merge-base, an unreadable or truncated tree, a head that has not actually
// diverged from the base — returns null, which the caller reads as "no carry"
// and falls through to today's red gate. Never throws: an unreadable read here
// must never crash the whole evaluation and leave the status pending forever.
//
// `compare(repository, from, to)` and `tree(repository, sha)` are the only I/O:
// review-gate.mjs's main() backs them with its trusted-workflow fetch.
export async function carriedApproval({ compare, tree, repository, head, reviews, baseRef }) {
  if (reviewerWithdrewOn(reviews, head)) return null;
  const prior = priorReviewerVerdict(reviews, head);
  if (!prior?.ok) return null;
  if (typeof baseRef !== 'string' || baseRef.trim().length === 0) return null;
  try {
    // How much of the base branch this head has already taken in: the merge
    // base of the two, so repeated integrations describe one approved change
    // integrated up to one base commit rather than a chain walked hop by hop.
    const toBase = await compare(repository, head, baseRef);
    const integrated = toBase?.merge_base_commit?.sha;
    if (!FULL_SHA.test(String(integrated ?? '')) || integrated === head) return null;

    const range = await compare(repository, prior.head, integrated);
    const forkPoint = range?.merge_base_commit?.sha;
    if (!FULL_SHA.test(String(forkPoint ?? ''))) return null;

    const [base, approved, taken, landing] = await Promise.all(
      [forkPoint, prior.head, integrated, head].map((sha) => tree(repository, sha)),
    );
    if (!treesCarryApproval({ base, approved, taken, landing })) return null;
    return { verdict: prior, integrated };
  } catch (error) {
    console.log(`review-gate: the carried-approval check could not be read (${error.message})`);
    return null;
  }
}

export async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = Number(process.env.GITHUB_RUN_ID);
  const serverUrl = process.env.GITHUB_SERVER_URL;
  if (!token || !repository || !Number.isSafeInteger(runId) || runId < 1 || serverUrl !== 'https://github.com') {
    throw new Error('review-gate: GITHUB_TOKEN, GITHUB_REPOSITORY, and one trusted GitHub run identity are required');
  }
  const runUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const event = eventPath ? JSON.parse(await (await import('node:fs/promises')).readFile(eventPath, 'utf8')) : {};

  // No commit status is a trigger since #2293: the reviewer is started by the
  // author and the native review is the only wake, read by commit_id below.
  if (event.context) {
    console.log('review-gate: a commit status is not a gate trigger — nothing to do');
    return;
  }
  const reviewWake =
    event.workflow_run?.event === 'pull_request_review' &&
    event.workflow_run?.status === 'completed' &&
    event.workflow_run?.conclusion === 'success' &&
    FULL_SHA.test(String(event.workflow_run?.head_sha ?? ''));
  if (event.workflow_run && !reviewWake) {
    console.log('review-gate: workflow run is not a completed reviewer wake — nothing to do');
    return;
  }

  let pullRequestNumber = event.pull_request?.number;
  const eventHead = event.pull_request?.head?.sha ?? (reviewWake ? event.workflow_run.head_sha : undefined);

  const api = async (path, init = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`);
    }
    return response.json();
  };
  const paged = async (path) => {
    const all = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await api(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`GitHub GET ${path}: expected an array`);
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  };
  const postStatus = async (head, state, description, targetUrl = runUrl) => {
    await api(`/repos/${repository}/statuses/${head}`, {
      method: 'POST',
      body: JSON.stringify({
        state,
        context: 'review/gate',
        description: description.slice(0, 140),
        target_url: targetUrl,
      }),
    });
    console.log(`review-gate: ${state} on ${head.slice(0, 8)} — ${description}`);
  };

  if (eventHead) await postStatus(eventHead, 'pending', 'evaluating');

  if (!pullRequestNumber && reviewWake) {
    const associated = await api(`/repos/${repository}/commits/${eventHead}/pulls?per_page=100`);
    const open = associated.filter((candidate) => candidate.state === 'open' && candidate.head?.sha === eventHead);
    if (open.length !== 1) {
      if (open.length > 1) {
        await postStatus(eventHead, 'failure', `head belongs to ${open.length} open pull requests`);
      } else {
        console.log('review-gate: wake head belongs to no open pull request — pending stands');
      }
      return;
    }
    pullRequestNumber = open[0].number;
  }
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    console.log('review-gate: event carries no pull request — nothing to do');
    return;
  }

  const pullRequest = await api(`/repos/${repository}/pulls/${pullRequestNumber}`);
  const head = pullRequest?.head?.sha;
  if (!FULL_SHA.test(String(head ?? ''))) throw new Error('the pull-request head is unreadable');
  if (eventHead && head !== eventHead) {
    console.log(`review-gate: wake names stale head ${eventHead.slice(0, 8)}; current head is ${head.slice(0, 8)}`);
    return;
  }
  if (!eventHead) await postStatus(head, 'pending', 'evaluating');
  if (typeof pullRequest.user?.login !== 'string' || pullRequest.user.login.length === 0) {
    console.log('review-gate: pull-request author is unreadable — pending stands');
    return;
  }

  const post = (state, description) => postStatus(head, state, description, pullRequest.html_url);
  const readCheckout = (file) => readFileSync(file, 'utf8');
  const headMoved = async () => (await api(`/repos/${repository}/pulls/${pullRequestNumber}`))?.head?.sha !== head;
  let settings;
  try {
    settings = readSettings(readCheckout);
  } catch (error) {
    console.log(`review-gate: the repository's gate settings are unreadable (${error.message}) — pending stands`);
    return;
  }
  const lane = parseLane(pullRequest.body);
  if (settings.ciOnly && lane !== 'undeclared') {
    await post('success', 'ci-only: declared lane permits merge on required CI');
    return;
  }
  let touched = null;
  if (lane === 'ordinary') {
    try {
      touched = guardedTouch(
        await paged(`/repos/${repository}/pulls/${pullRequestNumber}/files`),
        guardedSurface(settings, readCheckout),
      );
    } catch (error) {
      console.log(`review-gate: the guarded-surface check is unreadable (${error.message}) — pending stands`);
      return;
    }
    if (touched === null) {
      await post('success', 'ordinary: required CI is independently enforced');
      return;
    }
    console.log(`review-gate: declared ordinary, but the change touches ${touched} — treated as guarded`);
  }

  if (settings.dependabot && pullRequest.user.id === DEPENDABOT_ID) {
    let commits;
    try {
      commits = await paged(`/repos/${repository}/pulls/${pullRequestNumber}/commits`);
    } catch (error) {
      console.log(`review-gate: Dependabot attestation is unreadable (${error.message}) — pending stands`);
      return;
    }
    if (await headMoved()) {
      console.log(`review-gate: head moved while Dependabot attestation was read — not publishing on ${head.slice(0, 8)}`);
      return;
    }
    if (dependabotAttested(pullRequest, commits)) {
      await post('success', "Dependabot's own attested change; required CI is independently enforced");
      return;
    }
  }

  let reviews;
  try {
    reviews = await paged(`/repos/${repository}/pulls/${pullRequestNumber}/reviews`);
  } catch (error) {
    console.log(`review-gate: reviewer inventory is unreadable (${error.message}) — pending stands`);
    return;
  }
  if (await headMoved()) {
    console.log(`review-gate: head moved while reviews were read — not publishing on ${head.slice(0, 8)}`);
    return;
  }

  let verdict;
  try {
    verdict = reviewerVerdict(reviews, head);
  } catch (error) {
    console.log(`review-gate: exact-head reviewer verdict is unreadable (${error.message}) — pending stands`);
    return;
  }
  let carried = null;
  if (!verdict) {
    carried = await carriedApproval({
      compare: (repo, from, to) => api(`/repos/${repo}/compare/${from}...${encodeURIComponent(to)}`),
      tree: (repo, sha) => api(`/repos/${repo}/git/trees/${sha}?recursive=1`),
      repository,
      head,
      reviews,
      baseRef: pullRequest.base?.ref,
    });
  }
  let evaluation;
  try {
    evaluation = evaluateReviewVerdict({
      pullRequest: {
        number: pullRequestNumber,
        state: pullRequest.state,
        draft: pullRequest.draft === true,
        head,
        // A declared-ordinary change on the guarded surface is judged as guarded.
        body: touched === null ? pullRequest.body : '- Lane: guarded',
        createdAt: pullRequest.created_at,
      },
      reviews,
      reviewRequests: [],
      comments: [],
      timeline: [],
      statuses: [],
      carriedApproval: carried,
      author: 'working',
      reviewer: 'dead',
      now: Date.now(),
    });
  } catch (error) {
    console.log(`review-gate: reviewer verdict is unreadable (${error.message}) — pending stands`);
    return;
  }
  let description = evaluation.gate.description;
  if (touched !== null && evaluation.gate.colour === 'failure')
    description = `${touched} is guarded surface; ${description}`;
  if (carried && evaluation.gate.colour === 'success') {
    description =
      `guarded: head ${head.slice(0, 12)} only merges ${carried.integrated.slice(0, 12)} into` +
      ` approved head ${carried.verdict.head.slice(0, 12)} (review ${carried.verdict.id})`;
  }
  await post(evaluation.gate.colour, description);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
