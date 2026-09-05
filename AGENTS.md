# ci-tools repository rules

Shared CI tooling for todd-studio repositories. Consumers fetch scripts from this repo at a
pinned commit via raw.githubusercontent.com, so `main` is a published API:

- Never rewrite or force-push `main`. A consumer's pinned commit must keep meaning the same bytes.
- Changes must stay backward-compatible: flags and behaviour existing consumers rely on do not
  change. Add new behaviour alongside; retire old behaviour only after every consumer has moved.
- Scripts are POSIX-leaning bash that must run on both macOS (BSD tools) and ubuntu runners (GNU).
- This repo is public because CI fetches it unauthenticated. Nothing secret, ever.
