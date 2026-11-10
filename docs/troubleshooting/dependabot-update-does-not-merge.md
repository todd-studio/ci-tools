# A Dependabot update does not merge on its own

## What you see

Dependabot opened a pull request in a project that uses Dependabot auto-merge, and it sits open
instead of merging once its checks pass.

## Why it happens

Merging on its own takes two separate things: the **Dependabot auto-merge** workflow must arm
auto-merge on the exact head, and then every required check, `review/gate` included, must be
green. Either can be missing.

The workflow holds an update for agent review, printing `Not eligible: left for review` in its
**Arm eligible exact head** step, unless every one of these holds:

- the pull request is open, not a draft, by Dependabot's bot account, with exactly one commit, its
  head in the same repository and the default branch as its base;
- the head has not moved since the run started;
- every dependency in it is a minor or patch update (a major or unknown update type waits);
- every dependency's ecosystem is listed in the project's `.github/dependabot-auto-merge.json`,
  spelled as fetch-metadata's id (`npm_and_yarn`, `github_actions`, `uv`), not as Dependabot's
  config name (`npm`, `github-actions`).

The workflow fails red, arming nothing, when `.github/dependabot-auto-merge.json` is missing,
unreadable or has an unknown key or empty list, or when the merge App's secrets
(`DEPENDABOT_MERGE_APP_CLIENT_ID`, `DEPENDABOT_MERGE_APP_PRIVATE_KEY`) are missing from the
project's Actions or Dependabot secrets.

When it did arm (the step prints `Squash auto-merge requested for …`) but nothing merged, a
required check is not green. The usual one is `review/gate`: Dependabot never writes a `Lane:`
line, so unless the project's `.github/review-gate.json` sets `"dependabot": true`, the gate reads
the change as guarded and waits for a reviewer.

## What fixes it

1. Open the project's latest **Dependabot auto-merge** run for that pull request under Actions and
   read the last step's output.
2. Then:
   - **`Not eligible: left for review`:** this is the policy working. A major update, a
     multi-commit pull request or an ecosystem the project has not allowed receives an
     agent-assigned review issue through the
     **Route held update for agent review** step when the PR is trusted, open and current. The
     lane merges it or closes it with a reason. Repeated runs reuse the same issue, including
     closed review work; check that issue for the earlier decision. If the ecosystem should be
     allowed, add its fetch-metadata id to
     `.github/dependabot-auto-merge.json` on the default branch.
   - **Routing failed:** check the routing step for an API error, ensure the workflow grants
     `issues: write`, and ensure `toddagent01` can be assigned. Re-run after fixing it; the
     direct issue lookup reuses any work already created.
   - **The run failed:** fix the settings file on the default branch or set the App secrets, then
     re-run the failed run from Actions. It reads the settings and secrets afresh.
   - **Armed, but `review/gate` is red:** set `"dependabot": true` in the project's
     `.github/review-gate.json`, or review the pull request. See
     [The review gate is red](review-gate-is-red.md).
   - **Armed, but a CI check is red:** the update broke something; it needs review.
