# ci-tools

Shared CI tooling for todd-studio repositories. One canonical home per concern — consumers fetch
what they need at a pinned commit rather than carrying a copy that can drift.

New here? Start with [docs/start-here.md](docs/start-here.md), then the
[architecture map](ARCHITECTURE.md). This README is the reference a consumer copies from.

## ci-fetch.sh

Fetch a pinned release artifact and refuse to produce it unless its SHA-256 matches. CI downloads
a binary (gitleaks, yq, …) and then executes it; a pinned version is not a pinned artifact, and a
substituted scanner reporting nothing wrong passes silently. This is the single fetcher every
repository calls, rather than a checksum check copied beside each download.

Consume it pinned to a commit, never to a branch — and the pin covers ci-fetch.sh itself: fetch
it with a SHA-256 taken once from a checkout of that exact commit, and refuse to run it unless it
matches. Inline, that is:

```yaml
- name: Fetch the fetcher
  env:
    CI_TOOLS: <COMMIT>
    CI_FETCH_SHA256: <sha256 of ci-fetch.sh at that commit>
  run: |
    tmp="$(mktemp)"
    curl --fail --location --silent --show-error \
      "https://raw.githubusercontent.com/todd-studio/ci-tools/$CI_TOOLS/ci-fetch.sh" \
      --output "$tmp"
    echo "$CI_FETCH_SHA256  $tmp" | shasum -a 256 -c -
    chmod +x "$tmp"
    mv "$tmp" "$RUNNER_TEMP/ci-fetch.sh"
```

Most consumers carry this once as a small bootstrap script in their own repo rather than inlining
it in every workflow.

Then: `ci-fetch.sh <url> <sha256> <dest>`. The SHA-256 comes from the upstream project's own
published checksums, never from whatever a download happened to produce.

Originated in todd-studio/workstation (`scripts/ci-fetch.sh`); moved here so every repository
reads the same file.

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

## review-gate/

The `review/gate` commit status every todd-studio repository requires: a pull request whose body
declares `Lane: ordinary` is green without a reviewer; a guarded or undeclared one is green only on
`toddreviewer01`'s standing native approval of the exact current head, or of a head this one only
merges the base branch into. `review-verdict.mjs` is the one guarded-review verdict the gate
projects; todd-studio/workstation's `ws review wait`, backstop and router use the same file.
The backstop also checks approval provenance: a successful reviewer launch must name the
approved head, or a `ws-review-request` record for that head must follow a successful launch.
Both records must precede the approval; an earlier-head launch alone cannot vouch for it.

Lane parsing stops at the first standalone `<!-- codesmith:footer -->` line (trimmed and
case-insensitive), then strips HTML comments and requires exactly one declaration. Blacksmith's
literal footer append therefore cannot change the verdict of a body ending in a newline.
Mentions of the marker in prose do not end the declaration region; a declaration found only
in the footer is undeclared.
The lane token must be exactly `ordinary` or `guarded` (case-insensitive), followed by the end
of the line, whitespace, a comma or an opening parenthesis for an explanation. Joined suffixes
such as `guarded123`, `guarded/ordinary` and `ordinary-x` are undeclared. Unknown native-review
states from the trusted reviewer are unreadable; `COMMENTED` and `PENDING` remain non-verdicts.

The shared wait adapter accepts opt-in `recovery: true` for a merged pull request. It requires
an actual native `toddreviewer01` verdict on the exact head; neither merge completion nor a
green gate supplies that verdict. A `ws-review-launch` record with `recovery: true` supplies
the request clock after GitHub clears pending requests at merge. Existing round, launch and
time limits still apply. Normal merged waits can opt into `workflowCompletion: true` to return
`done` instead of the legacy `approved` workflow-completion label; old defaults remain compatible.

Cleanup adapters use `evaluateRecoveryCleanup({pullRequest: {state, head}, reviews, comments,
now, stuckMs})`, returning `{action: 'hold' | 'reclaim', reason}`. Use normalized `OPEN`,
`MERGED` or `CLOSED` state, native REST or GraphQL reviews and a millisecond clock (`stuckMs`
defaults to 30 minutes). Open pull requests hold; closed-unmerged pull requests reclaim.
For a merged recovery, post a `ws-review-request` v1 record before creating a terminal:
`recovery: true`, unique nonempty `attempt`, exact `head`, RFC3339 `at`, `host` and `workspace`.
The confirming `ws-review-launch` record carries the same `attempt` and normal launch fields;
readiness failure posts `failed: true` for that attempt. A new attempt needs a new intent.

The latest recovery intent owns its deadline; readiness never extends it. Only a matching
attempt can confirm or fail it. A native exact-head verdict, failed matching launch, expiry
or exhausted round/seated-launch budget ends protection. Recovery launches without an intent
retain the bounded launch-clock behavior. Request mode can use the intent without a GitHub
review request. Unreadable inventories throw for the caller to handle; this decision never
changes the gate or performs cleanup. Workstation owns CLI, credentials and process liveness.

A consumer runs it from a `pull_request_target` workflow that checks out its own default branch
(never the pull request) and fetches both files at a pinned commit, each SHA-256 checked:

    scripts/review-gate.pin          commit <40-hex>
                                     <sha256>  ci-fetch.sh
                                     <sha256>  review-gate/review-gate.mjs
                                     <sha256>  review-gate/review-verdict.mjs

    node "$RUNNER_TEMP/review-gate/review-gate.mjs"     # cwd = the default-branch checkout

Take the hashes once, from a checkout of that exact commit. A fetch that fails or mismatches posts
nothing, and an absent required context blocks.

What differs between repositories is a setting, never a fork: `.github/review-gate.json` in the
consumer's default branch. Absent means none. Present but unreadable, malformed or naming an
unknown key, the gate publishes nothing past `pending`. Defaults apply only to omitted settings;
explicit `null` is malformed.

```json
{
  "guardedFiles": [
    "scripts/reviewed-destructive-migrations.json",
    "ecosystem.main-live.config.cjs",
    ".github/workflows/review-gate.yml",
    "scripts/review-gate.pin"
  ],
  "guardedEntryPoints": ["scripts/release-pass.cjs", "scripts/release-scheduler.mjs"],
  "dependabot": true,
  "ciOnly": false
}
```

- `guardedFiles`, `guardedEntryPoints`: a change declared ordinary that touches one of these files,
  or a module an entry point reaches through relative import specifiers spelled as exact file
  paths, is judged as guarded (an extensionless or directory specifier is not followed). Whitespace
  and JavaScript comments may separate the import/require tokens and the quoted path. The
  settings file itself is always on that surface; list the gate's own workflow and pin to keep an
  ordinary change from moving the gate.
- `dependabot`: Dependabot's own change (its app identity, a same-repository head, every commit
  authored by it, committed by GitHub's web-flow and signature-verified) needs no reviewer; required
  CI stays enforced. It is checked before the guarded surface's reviewer requirement, so an attested
  Dependabot change is green even where it touches the surface.
- `ciOnly`: a readable `ordinary` or `guarded` declaration needs no reviewer; required CI remains
  independently enforced. Missing, malformed, placeholder, or ambiguous declarations fail without reading
  reviewer evidence, except an attested Dependabot change where `dependabot` is also set: Dependabot
  never declares a lane, so its attestation is checked first. It defaults to `false`, preserving the
  shared gate's normal review policy.

ci-tools gates itself with the same file. Its `.github/workflows/review-gate.yml` runs
`review-gate/review-gate.mjs` from its own default-branch checkout rather than a pinned fetch, so
a pull request never supplies the code that judges it; a change to the gate takes effect here only
once it merges. `main` requires `review/gate` beside every CI job. Its `.github/review-gate.json`
puts `ci-fetch.sh`, the gate's code and the workflows that run them on the guarded surface, and
lets Dependabot's own attested change through without a reviewer.

Public, no secrets. Originated in todd-studio/workstation's `scripts/review-gate.mjs` and
`services/review-verdict.mjs` (WS #3040), with todd-studio/plates-web's surface and Dependabot
rules as settings.

## dependabot-auto-merge/

Requests squash auto-merge for Dependabot's minor and patch updates in the ecosystems a consumer
allows. Required CI and `review/gate` remain the merge authority. The workflow first clears any
prior auto-merge request, then verifies fresh metadata and asks to arm the exact event head with
`gh pr merge --auto --squash --match-head-commit`. Only an open, non-draft PR by Dependabot's Bot
user id `49699333`, with exactly one commit, a same-repository head and the default branch as base,
qualifies. Every dependency in a group must qualify; major updates and unknown update types wait
for review. `dependabot/fetch-metadata` verifies only the first commit, hence the one-commit limit.

The consumer's default-branch checkout must contain `.github/dependabot-auto-merge.json`:

```json
{
  "ecosystems": ["npm_and_yarn", "github_actions", "uv"],
  "reviewPriorityFieldId": 46102352
}
```

Choose only the ecosystems that repository allows. Values are fetch-metadata's `packageEcosystem`
ids (lowercase letters, digits and underscores), such as `npm_and_yarn`, `github_actions` and `uv`,
not Dependabot configuration names such as `npm` or `github-actions`. A value only matches that
exact metadata id; an unmatched id authorizes nothing. There is no default policy: a missing,
unreadable or malformed file, unknown key, or empty list throws and the job fails red without
arming. `--clear` does not read settings or dependency metadata, so a broken policy cannot stop
withdrawal of a prior request.

Consumers keep `scripts/dependabot-auto-merge.pin` in the same format as `review-gate.pin`:

```text
commit <40-hex ci-tools commit>
<sha256>  ci-fetch.sh
<sha256>  dependabot-auto-merge/dependabot-auto-merge.mjs
```

Take both hashes from a checkout of that exact published commit, never from a workflow's download:

```sh
shasum -a 256 ci-fetch.sh dependabot-auto-merge/dependabot-auto-merge.mjs
```

Move the commit and hashes together. The existing consumer `scripts/ci-fetch-bootstrap.sh` verifies the fetcher
before it runs, then `ci-fetch.sh` verifies the standalone script; no local imports or install are
needed. Put the workflow, pin, settings and bootstrap on `.github/review-gate.json`'s `guardedFiles`
surface, so an ordinary change cannot move the credential's trusted code or policy.

Use this exact `.github/workflows/dependabot-auto-merge.yml` text in every consumer; repository
policy belongs only in the settings and the pin:

```yaml
# Run trusted default-branch code only; never install or execute the PR's tree.
# GitHub's required checks (including review/gate) remain the merge authority.
name: Dependabot auto-merge
on:
  pull_request_target:
    types: [opened, reopened, synchronize, edited, ready_for_review, converted_to_draft]
permissions:
  contents: write
  pull-requests: write
  issues: write
jobs:
  arm:
    if: github.event.pull_request.user.id == 49699333 && github.event.pull_request.user.type == 'Bot'
    runs-on: ubuntu-latest
    timeout-minutes: 3
    concurrency:
      group: dependabot-auto-merge-${{ github.event.pull_request.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
      - name: Fetch pinned Dependabot arming script
        run: |
          pin=scripts/dependabot-auto-merge.pin
          commit="$(awk '$1 == "commit" { print $2 }' "$pin")"
          want() { awk -v f="$1" '$2 == f { print $1 }' "$pin"; }
          base="https://raw.githubusercontent.com/todd-studio/ci-tools"
          script=dependabot-auto-merge/dependabot-auto-merge.mjs
          mkdir -p "$RUNNER_TEMP/dependabot-auto-merge"
          scripts/ci-fetch-bootstrap.sh "$commit" "$(want ci-fetch.sh)" "$RUNNER_TEMP/ci-fetch.sh"
          "$RUNNER_TEMP/ci-fetch.sh" "$base/$commit/$script" "$(want "$script")" "$RUNNER_TEMP/$script"
      # Withdraw any earlier request before verification, including when metadata
      # fails. A synchronize event must earn eligibility again for its new head.
      - name: Clear prior auto-merge
        run: node "$RUNNER_TEMP/dependabot-auto-merge/dependabot-auto-merge.mjs" --clear
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - id: metadata
        uses: dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98 # v3.1.0
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
      # Keep this in the same per-PR concurrency group as clear and arm.
      # GITHUB_TOKEN can assign work without any new merge-App permissions;
      # the router discovers it through the assigned-open-issue sweep.
      - name: Route held update for agent review
        run: node "$RUNNER_TEMP/dependabot-auto-merge/dependabot-auto-merge.mjs" --route-held
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          UPDATED_DEPENDENCIES: ${{ steps.metadata.outputs.updated-dependencies-json }}
      # An auto-merge is made by whoever armed it, and GitHub starts no workflow
      # for a merge GITHUB_TOKEN armed (plates-web#1685). Arm as the repository's
      # merge app so main's push CI runs. A missing app secret fails red; it never falls
      # back to GITHUB_TOKEN.
      - id: merge-app
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: ${{ secrets.DEPENDABOT_MERGE_APP_CLIENT_ID }}
          private-key: ${{ secrets.DEPENDABOT_MERGE_APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
          permission-workflows: write
      - name: Arm eligible exact head
        run: node "$RUNNER_TEMP/dependabot-auto-merge/dependabot-auto-merge.mjs"
        env:
          GH_TOKEN: ${{ steps.merge-app.outputs.token }}
          UPDATED_DEPENDENCIES: ${{ steps.metadata.outputs.updated-dependencies-json }}
```

The merge App must be installed on that repository with Contents, Pull requests and Workflows
write permissions. Set `DEPENDABOT_MERGE_APP_CLIENT_ID` and `DEPENDABOT_MERGE_APP_PRIVATE_KEY` in
both its Actions and Dependabot secret stores. The token is scoped to the current repository;
arming as the App allows the merge's `push` CI to run. Missing secrets or refused permissions fail
red with no fallback to `GITHUB_TOKEN`; the daily Dependabot backstop can still handle the update.
See [create-github-app-token's permissions](https://github.com/actions/create-github-app-token#inputs)
and [fetch-metadata's outputs](https://github.com/dependabot/fetch-metadata#outputs).

`--route-held` is an additive, routing-only call: with fresh metadata and settings it creates or
reuses an issue assigned to `toddagent01` for an open, non-draft, exact-event-head Dependabot
update that does not qualify for auto-merge. The same-repository and default-base checks still
apply; multi-commit updates can receive review. It never arms a merge. The issue links the source
PR and asks its lane to merge it through normal policy or close it with a reason.

Routing requires `reviewPriorityFieldId` in the existing settings file: it is the organization's
native Priority field ID (`46102352` for todd-studio), with a `Medium` option. An organization
operator can obtain it from `gh api orgs/OWNER/issue-fields`; the workflow token needs no
organization permission. Created work has native type `Maintenance` and native Priority `Medium`,
verified by a fresh issue read before reporting success. Neither value is duplicated in its body.
Missing settings or refused/unconfirmed metadata fail the routing step. The setting is optional
for the existing no-argument arming and `--clear` calls. Other organizations must supply their own
field ID and enable the Maintenance type.

Use the workflow token with `issues: write` for that step, as shown above; the merge App needs no
new permissions. GitHub may suppress the issue webhook for this token, so discovery relies on the
router's assigned-open-issue sweep. Keep all calls serialized in the existing per-PR concurrency
group with `cancel-in-progress: false`: the API has no atomic create-if-absent operation. Routing
reads repository issues directly, including closed work, filtered to those the GitHub Actions bot
created and updated since the source PR opened, so the lookup stays a request or two however long
the issue history grows. It matches a stable body
marker keyed by repository and PR number, never by head SHA, only on issues created by the
GitHub Actions bot's immutable ID and Bot type. A copied marker from another creator is ignored,
including on closed issues; unrelated issue text never receives assignment through this helper.
Repeated runs and later heads reuse
that issue; open work missing metadata or its assignment is repaired, preserving later type and
priority decisions, and closed work stays closed. A fresh
PR read immediately before a write refuses a moved or closed request; GitHub cannot atomically
couple an issue write to a PR head, so a later movement is handled by the lane reviewing the
current head. Unreadable replies, failed writes or a missing returned assignment fail the job.
The original no-argument and `--clear` calls retain their behavior.

ci-tools uses the same clear/metadata/route/App/arm steps, running the script and settings from its own
default-branch checkout rather than fetching itself. No pull-request code is checked out or run;
changes to this workflow take effect only after merging. Its policy allows `github_actions`.
Tests run in the required `review gate` CI job, replaying captured GitHub and fetch-metadata replies
from [plates-web#1689](https://github.com/todd-studio/plates-web/pull/1689). Originated in todd-studio/plates-web's arming script and workflow
(WS #5159).
