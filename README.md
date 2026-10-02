# ci-tools

Shared CI tooling for todd-studio repositories. One canonical home per concern — consumers fetch
what they need at a pinned commit rather than carrying a copy that can drift.

## ci-fetch.sh

Fetch a pinned release artifact and refuse to produce it unless its SHA-256 matches. CI downloads
a binary (gitleaks, yq, …) and then executes it; a pinned version is not a pinned artifact, and a
substituted scanner reporting nothing wrong passes silently. This is the single fetcher every
repository calls, rather than a checksum check copied beside each download.

Consume it pinned to a commit, never to a branch:

```yaml
- name: Fetch the fetcher
  run: |
    curl --fail --location --silent --show-error \
      "https://raw.githubusercontent.com/todd-studio/ci-tools/<COMMIT>/ci-fetch.sh" \
      --output "$RUNNER_TEMP/ci-fetch.sh"
    chmod +x "$RUNNER_TEMP/ci-fetch.sh"
```

Then: `ci-fetch.sh <url> <sha256> <dest>`. The SHA-256 comes from the upstream project's own
published checksums, never from whatever a download happened to produce.

Originated in todd-studio/workstation (`scripts/ci-fetch.sh`); moved here so every repository
reads the same file. Workstation's migration to this copy is tracked separately.

## docs-parts/

The shared documentation check, run by `ws ship` and CI in every repository that has a
`docs-site/parts.json`: part coverage, the pull-request `Docs:` answer, code-link fingerprints and
boundary rules with a crossings ratchet. What each subcommand does is in the header of
`docs-parts/docs-parts.mjs`.

Fetch its four files into one directory, at one pinned commit, through `ci-fetch.sh`:
`docs-parts/docs-parts.mjs`, `code-links.mjs`, `remark-code-links.mjs` and `acorn.mjs`. The `coverage` and `answer` subcommands need nothing else. `links` and `boundaries` read
JavaScript with acorn, which the consumer installs; `acorn.mjs` looks for it in `$ACORN_PATH`, then by
name, then `docs-site/node_modules` and `node_modules`. When it finds none the command exits 2: it never
passes without having read the code.

Originated in todd-studio/workstation (`scripts/docs-parts.mjs`, `docs-site/lib/code-links.mjs`).
Behaviour stays backward-compatible with that copy; the workstation switch to this one is tracked in
todd-studio/workstation#2763.
