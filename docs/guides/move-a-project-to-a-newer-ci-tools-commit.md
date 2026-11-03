# Move a project to a newer ci-tools commit

A project runs a ci-tools change only once it moves its pin: the ci-tools commit it fetches from
and the SHA-256 of each file at that commit. Do this to pick up a fix or a new feature here. Each
pin moves on its own, so a project can be on different commits for different tools.

## Which pin holds which tool

| Pin, in the consuming project                         | Lines it holds                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml` env                        | `CI_TOOLS_COMMIT` and `CI_FETCH_SHA256` (the hash of `ci-fetch.sh`)                                                                     |
| `scripts/review-gate.pin`                             | `commit <40-hex>`, then `<sha256>  <path>` for `ci-fetch.sh`, `review-gate/review-gate.mjs` and `review-gate/review-verdict.mjs`         |
| `scripts/dependabot-auto-merge.pin`                   | `commit <40-hex>`, then `ci-fetch.sh` and `dependabot-auto-merge/dependabot-auto-merge.mjs`                                              |
| `scripts/docs-parts.pin`                              | `commit <40-hex>`, then `docs-parts.mjs`, `code-links.mjs`, `package.json` and `package-lock.json` (names without the `docs-parts/` folder) |

Not every project has every pin; a project without a file does not use that tool.

## Steps

1. **Choose the commit.** Use a full 40-character commit on ci-tools `main`:

   ```sh
   git -C <ci-tools checkout> fetch origin
   git -C <ci-tools checkout> rev-parse origin/main
   ```

   A commit on `main` keeps meaning the same bytes because `main` is never rewritten. A commit
   that only exists on a branch can disappear, and the fetch then fails.

2. **Read what changed for the files you pin.** For example, for the review gate:

   ```sh
   git -C <ci-tools checkout> log --oneline <current commit>..<new commit> -- review-gate/ ci-fetch.sh
   ```

   Check the [README](../../README.md) for any new setting or flag the change expects.

3. **Take each hash from that commit's own tree**, never from what a CI run downloaded:

   ```sh
   git -C <ci-tools checkout> show <new commit>:review-gate/review-gate.mjs | shasum -a 256
   ```

   Repeat for every file the pin lists. On Linux, `sha256sum` gives the same hash.

4. **Write the commit and every hash for that pin together.** A pin whose commit and hashes
   disagree is refused, which is the point: they move together or not at all. In
   todd-studio/workstation, also replace `services/review-verdict.mjs` with the pinned
   `review-gate/review-verdict.mjs`: workstation's tests check that its copy hashes to the pin.

5. **Open the pull request.** Pins, workflows and the bootstrap are usually on the project's
   guarded surface (its `.github/review-gate.json`), so moving one is judged as guarded and needs
   `toddreviewer01`'s approval, however small the diff.

6. **Check the run.** Each verified file prints `ci-fetch: verified <file> -> <path>`. A run that
   prints `ci-fetch: REFUSING` instead has a hash that does not match the commit; see
   [`ci-fetch: REFUSING` stops a CI run](../troubleshooting/ci-fetch-refuses-a-download.md).

The review gate runs from the default branch, so a new review-gate pin takes effect on pull
requests opened or updated after the pin merges, not on the pull request that moves it.
