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

The shared docs check: part coverage, the PR `Docs:` answer, code-link fingerprints, boundary rules
and the crossings ratchet, run against a repository's own `docs-site/parts.json`. `docs-parts.mjs`
and `code-links.mjs` (which exports `readCodeLink` for a consumer's docs-site plugin) are one unit
with `package.json` and `package-lock.json`: fetch all four at the same pinned commit, verify each
SHA-256 with `ci-fetch.sh`, then run `npm ci --ignore-scripts` in the directory. Without it
`links` and `boundaries` exit 2 — they never pass for want of a parser.

    node docs-parts/docs-parts.mjs coverage|answer|links|refresh|boundaries --root <repo>

Fetching, with `ci-fetch.sh` already on the runner (see above). Take the hashes once, when you
choose the commit, from a checkout of that exact commit (`sha256sum docs-parts/<file>`), and keep
them in your workflow next to the commit they belong to; a hash is never recomputed from what a
run downloaded:

```yaml
- name: Fetch docs-parts
  env:
    CI_TOOLS: <COMMIT>
  run: |
    mkdir -p docs-parts
    while read -r f sha; do
      "$RUNNER_TEMP/ci-fetch.sh" \
        "https://raw.githubusercontent.com/todd-studio/ci-tools/$CI_TOOLS/docs-parts/$f" \
        "$sha" "docs-parts/$f"
    done <<'EOF'
    docs-parts.mjs <sha256>
    code-links.mjs <sha256>
    package.json <sha256>
    package-lock.json <sha256>
    EOF
    npm ci --ignore-scripts --prefix docs-parts
```

A repository with no `docs-site/parts.json` is treated as not opted in: the checks say so and
exit 0. A wrong `--root` therefore also reads as not opted in. A consumer that has opted in should
pass `--require-registry` to any command: a missing registry or wrong `--root` then exits 2
("cannot decide") instead of passing. The flag is opt-in so pinned consumers keep their behaviour.

Public, no secrets. Originated in todd-studio/workstation's `scripts/docs-parts.mjs` at 762394b9.
