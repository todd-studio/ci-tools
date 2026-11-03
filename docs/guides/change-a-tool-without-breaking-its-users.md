# Change a tool without breaking the projects that use it

Every commit on ci-tools `main` is something a project may already have pinned, and projects
move their pins at their own pace. So a change here must leave every flag and behaviour a project
relies on working exactly as before. New behaviour is added beside the old, usually as a flag or a
setting that defaults to the old behaviour. Old behaviour is retired only after every project has
moved past it.

Two examples already here: `--require-registry` makes the docs check fail when the registry is
missing, but only for a project that passes it; `ciOnly` in `.github/review-gate.json` defaults to
`false`, so a project that never set it keeps the normal review policy.

## Steps

1. **Branch from a freshly fetched `origin/main`** and make the change. Shell scripts must work
   with both macOS (BSD) and Ubuntu (GNU) tools; `ci-fetch.sh`'s tests run on both.

2. **Run the same tests CI runs:**

   ```sh
   bash tests/ci-fetch.test.sh
   npm ci --ignore-scripts --prefix docs-parts
   node --test tests/docs-parts.test.mjs tests/code-links.test.mjs
   node --test tests/review-gate.test.mjs tests/review-verdict.test.mjs tests/dependabot-auto-merge.test.mjs
   ```

   The review-gate and Dependabot tests replay real GitHub replies kept in `tests/fixtures/`, each
   with a `source` line saying where it was captured. A new case that depends on a GitHub reply
   uses a captured one too, never a guessed shape.

3. **Update the [README](../../README.md)** in the same pull request when how a project calls the
   tool, or what it does, changes. Update [the architecture map](../../ARCHITECTURE.md) when a
   part's job or boundary changes.

4. **Declare the lane.** `.github/review-gate.json` puts these on the guarded surface:
   `ci-fetch.sh`; the `ci.yml`, `review-gate.yml` and `dependabot-auto-merge.yml` workflows; the
   Dependabot script and its settings; `.github/review-gate.json` itself; and
   `review-gate/review-gate.mjs` with every file it imports (so `review-verdict.mjs` too). A
   change to any of these is guarded and needs `toddreviewer01`'s approval, even if the pull
   request says ordinary. A change to `docs-parts/` alone, or to docs, can be ordinary.

5. **After the merge, nothing changes for any project** until it moves its pin. Move each
   project that needs the change:
   [Move a project to a newer ci-tools commit](move-a-project-to-a-newer-ci-tools-commit.md).

A change to `review-gate/` or `dependabot-auto-merge/` takes effect on ci-tools itself only after
it merges, because this repository runs both from its own default branch.

Never rewrite or force-push `main`: a project's pinned commit must keep meaning the same bytes.
