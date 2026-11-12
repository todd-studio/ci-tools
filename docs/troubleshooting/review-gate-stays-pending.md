# The review gate stays pending

## What you see

A pull request's `review/gate` check sits at pending ("evaluating") and never turns green or red,
or is missing altogether. The pull request cannot merge, because `review/gate` is required and a
pending or absent required check blocks.

## Why it happens

The gate is built to fail closed: when it cannot be sure, it publishes nothing past pending rather
than guess. It posts pending as soon as it starts, then stops without a verdict when:

- the project's `.github/review-gate.json` is unreadable, malformed or names an unknown setting;
- the pull request's changed-file list, commits or reviews cannot be read (including a file list
  that reaches GitHub's 3,000-file cap, which could be cut short);
- the pull request's head moved while the gate was reading, so its answer would be about an old
  head;
- a reply from GitHub has a shape the gate does not recognise, such as an unknown review state
  from `toddreviewer01`;
- a GitHub API call failed outright, which also fails the **Review gate** run itself. The gate
  retries a GitHub 5xx or a network error three times over about seven seconds first, so one
  flaky answer no longer stops it; a failure that outlasts the retries fails the run.

The check is missing altogether, with no pending, when the run failed before the gate started:
the project has no `scripts/review-gate.pin` on its default branch, or the pinned gate files could
not be fetched or failed their hash check.

## What fixes it

1. Open the check's **Details** link, or the project's latest **Review gate** run under Actions.
   Every reason the gate stops is printed as a line starting `review-gate:`, for example
   `review-gate: the repository's gate settings are unreadable (…) — pending stands`.
2. Fix what that line names:
   - **Settings unreadable:** correct `.github/review-gate.json` on the default branch. The only
     keys are `guardedFiles`, `guardedEntryPoints`, `dependabot` and `ciOnly`; explicit `null` is
     malformed. The settings file is guarded, so that fix needs a reviewer.
   - **Head moved:** nothing to fix. The push that moved it starts a fresh evaluation.
   - **A fetch or hash failure:** see
     [ci-fetch says REFUSING and stops a CI run](ci-fetch-refuses-a-download.md).
   - **No pin:** the project has not set up the gate; the README's `review-gate/` section shows
     what it needs.
3. To re-run the gate once the cause is fixed, push to the pull request or edit its body. Either
   starts a new evaluation.

A green or red result is never posted on a head other than the one it judged, so an old pending
status on a superseded head can be ignored.
