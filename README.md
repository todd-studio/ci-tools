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
