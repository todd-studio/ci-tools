# ci-tools

ci-tools is a small toolbox that the other todd-studio projects' automated checks borrow. Each
project's checks (CI, on GitHub Actions) download a tool from here at one exact version and
refuse to run it unless its fingerprint matches. Every project then runs the same bytes, and none
keeps a copy that can drift.

It holds four tools:

- **The safe downloader** (`ci-fetch.sh`). It downloads a file and keeps it only if the file's
  SHA-256 fingerprint matches the one the caller expected. Every other tool here comes through
  it, and so do the binaries a project's CI installs (gitleaks, yq and so on).
- **The docs check** (`docs-parts/`). In a project that maps its files to named parts, it checks
  that every file belongs to a part, that a pull request touching a part's code updates its pages
  or says why they are still true, and that code shown on a docs page has not changed since
  someone last read it.
- **The review gate** (`review-gate/`). It posts the `review/gate` check every project requires
  before merging. An ordinary change passes without a reviewer; a guarded one passes only once
  the independent reviewer account, `toddreviewer01`, has approved its exact latest version.
- **Dependabot auto-merge** (`dependabot-auto-merge/`). It lets Dependabot's small, safe version
  bumps merge on their own once every required check is green.

## How the pieces connect

A project never asks for "the latest" ci-tools. It writes down one ci-tools commit and the
fingerprint of each file it needs at that commit (its _pin_), and its CI fetches exactly those
files. So publishing a change here changes nothing anywhere until a project moves its pin. That
is why `main` here is treated as a published API: it is never rewritten, and a change must not
break a project still pinned to an older commit.

What differs between projects is a settings file in that project, never a separate copy of the
tool. ci-tools itself has no server, database or deploy; it is files on GitHub that other
projects read.

ci-tools also uses its own review gate and Dependabot auto-merge on itself, running them from its
own `main` rather than a pin.

## Where to go next

- [The architecture map](../ARCHITECTURE.md): each tool's job and boundaries, how a project
  fetches them, the flows through the review gate, and where the decisions are recorded.
- Guides, one task each:
  - [Move a project to a newer ci-tools commit](guides/move-a-project-to-a-newer-ci-tools-commit.md)
  - [Change a tool without breaking the projects that use it](guides/change-a-tool-without-breaking-its-users.md)
- Troubleshooting, one symptom each:
  - [`ci-fetch: REFUSING` stops a CI run](troubleshooting/ci-fetch-refuses-a-download.md)
  - [`review/gate` stays pending](troubleshooting/review-gate-stays-pending.md)
  - [`review/gate` is red](troubleshooting/review-gate-is-red.md)
  - [The docs check says "cannot decide"](troubleshooting/docs-check-cannot-decide.md)
  - [A Dependabot update does not merge on its own](troubleshooting/dependabot-update-does-not-merge.md)
- The [README](../README.md) is the developer reference: the exact fetch steps, settings and
  workflow text a project copies.
