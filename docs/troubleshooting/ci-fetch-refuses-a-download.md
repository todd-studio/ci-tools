# `ci-fetch: REFUSING` stops a CI run

## What you see

A CI step fails with:

```text
ci-fetch: REFUSING https://…/<file>
  expected sha256 <hash from the pin>
  actual   sha256 <hash of what was downloaded>
  The pinned artifact changed. Do not update the hash to match until you know why.
```

The same shape from `ci-fetch-bootstrap: REFUSING` means the check failed on `ci-fetch.sh`
itself, before any other download.

## Why it happens

`ci-fetch.sh` downloads the file and compares its SHA-256 with the hash the project pinned. They
differ, so it exits 1 and leaves nothing at the destination. Nothing downstream can run a file
that failed this check. The usual causes, most likely first:

- **The pin was moved by hand and its commit and hashes disagree.** For example, the commit was
  moved but one hash was left at the old value, or a hash was taken from a different commit.
- **A hash was copied from a CI download instead of from the commit's own tree.**
- **For a third-party binary (gitleaks, yq and so on): the release asset changed upstream.** A
  release can be re-uploaded or a tag moved. This is exactly what the check exists to catch, so
  treat it as possibly hostile until you know otherwise.

A ci-tools file at a fixed commit cannot change, because a commit is git's own content hash and
ci-tools `main` is never rewritten.

## What fixes it

1. Find which pin the failing file came from (see the table in
   [Move a project to a newer ci-tools commit](../guides/move-a-project-to-a-newer-ci-tools-commit.md)).
2. For a ci-tools file, recompute the hash from that exact commit:

   ```sh
   git -C <ci-tools checkout> show <pinned commit>:<path> | shasum -a 256
   ```

   If it matches the "actual" line, the pin's hash was wrong: correct it, with the commit and
   every other hash in that pin checked the same way.

3. For a third-party binary, compare the "actual" hash with the checksums the upstream project
   publishes for that release. If upstream's published checksum is the "expected" one, do not
   change the pin: the download is not what was released. Find out why first.

Never update the hash to whatever the run downloaded just to make it pass.

`ci-fetch: could not download <url>` is a different failure: the URL did not answer. Check that
the pinned commit exists on ci-tools `main` and that the path is spelled as it is at that commit.
