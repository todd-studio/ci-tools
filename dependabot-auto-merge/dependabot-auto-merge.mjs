// fetch-metadata verifies/parses only the first commit. Restrict eligibility
// to a single commit so its metadata describes the entire proposed update.
// The native ruleset independently holds CI and review/gate at the merge seam.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Resolve both paths: macOS /tmp and symlinked directories must still run the CLI.
function isEntryPoint(moduleUrl) {
  if (typeof process.argv[1] !== "string" || process.argv[1] === "") {
    throw new Error("cannot tell whether this module is the entry point");
  }
  return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
}

function readSettings(path) {
  const settings = JSON.parse(readFileSync(path, "utf8"));
  if (
    !settings || typeof settings !== "object" || Array.isArray(settings) ||
    Object.keys(settings).some((key) => key !== "ecosystems") ||
    !Array.isArray(settings.ecosystems) || settings.ecosystems.length === 0 ||
    settings.ecosystems.some((id) => typeof id !== "string" || !/^[a-z][a-z0-9_]*$/.test(id))
  ) {
    throw new Error("Invalid Dependabot auto-merge settings: expected a nonempty ecosystems list");
  }
  return settings;
}

function trustedOpenPull({
  pullRequest,
  expectedHead,
  repositoryId,
  defaultBranch,
}) {
  return (
    /^[a-f0-9]{40}$/.test(expectedHead ?? "") &&
    typeof repositoryId === "number" &&
    typeof defaultBranch === "string" &&
    defaultBranch.length > 0 &&
    pullRequest?.state === "open" &&
    pullRequest.draft === false &&
    pullRequest.user?.id === 49699333 &&
    pullRequest.user?.type === "Bot" &&
    pullRequest.head?.sha === expectedHead &&
    pullRequest.head?.repo?.id === repositoryId &&
    pullRequest.base?.repo?.id === repositoryId &&
    pullRequest.base?.ref === defaultBranch
  );
}

export function eligibleUpdate(facts) {
  const { pullRequest, dependencies, ecosystems } = facts;
  return (
    trustedOpenPull(facts) &&
    pullRequest.commits === 1 &&
    Array.isArray(dependencies) &&
    dependencies.length > 0 &&
    dependencies.every(
      (dependency) =>
        ecosystems.includes(dependency?.packageEcosystem) &&
        ["version-update:semver-patch", "version-update:semver-minor"].includes(
          dependency.updateType,
        ),
    )
  );
}

// The caller serializes runs per source PR. Use the repository issues endpoint
// (not search's delayed index), including closed issues so a later head cannot
// create a second task after the first lane made its decision.
function routeHeldPull({ repository, number, expectedHead, gh, stillHeld }) {
  const marker = `<!-- ci-tools:dependabot-review ${repository}#${number} -->`;
  const assignee = "toddagent01";
  const pages = gh([
    "api", `repos/${repository}/issues?state=all&per_page=100`, "--paginate",
    // Filter before gh returns the body: a large repository's issue history
    // otherwise exceeds execFileSync's output buffer. JSON quoting is jq-safe.
    "--jq", `[.[] | select(.pull_request == null and ((.body // "" | split("\\n") | index(${JSON.stringify(marker)})) != null))] | @json`,
  ]).trim().split("\n").map((page) => JSON.parse(page));
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    throw new Error("Unreadable review issue list");
  }
  const existing = pages.flat().find((issue) =>
    !issue.pull_request && typeof issue.body === "string" && issue.body.split("\n").includes(marker));
  const checkedIssue = (issue) => {
    if (!Number.isSafeInteger(issue?.number) || issue.number <= 0 ||
        !["open", "closed"].includes(issue.state) || !Array.isArray(issue.assignees)) {
      throw new Error("Unreadable review issue");
    }
    return issue;
  };
  if (existing) {
    checkedIssue(existing);
    if (existing.state === "open" && !existing.assignees.some((user) => user.login === assignee)) {
      if (!stillHeld()) return "Not routed: pull request changed";
      const assigned = checkedIssue(JSON.parse(gh([
        "api", `repos/${repository}/issues/${existing.number}/assignees`,
        "--method", "POST", "-f", `assignees[]=${assignee}`,
      ])));
      if (!assigned.assignees.some((user) => user.login === assignee)) {
        throw new Error("Review issue assignment was not applied");
      }
    }
    return `Review work reused: ${repository} issue ${existing.number} (${existing.state})`;
  }
  if (!stillHeld()) return "Not routed: pull request changed";
  const source = `https://github.com/${repository}/pull/${number}`;
  const body = `${marker}\n\n## Problem and effect\n\nDependabot update [${repository} PR ${number}](${source}) was held by the shared auto-merge policy at head ${expectedHead}. It needs an agent decision.\n\n## Outcome\n\nReview the source pull request's current head, update compatibility and required checks. Merge it through the repository's normal policy, or close it with a reason on the source PR. Do not loosen auto-merge eligibility or bypass required checks.\n\n## Proof\n\nLink the merged source PR and passing checks, or the closed source PR and its reason. Close this review issue only after that evidence exists.\n\n## Routing\n\nPriority: normal. No known blockers. This issue is the review work for this source PR across all later heads; reuse it rather than filing another.\n`;
  const created = checkedIssue(JSON.parse(gh([
    "api", `repos/${repository}/issues`, "--method", "POST",
    "-f", `title=Review held Dependabot update: ${repository} PR ${number}`,
    "-f", `body=${body}`, "-f", `assignees[]=${assignee}`,
  ])));
  if (created.state !== "open" || !created.assignees.some((user) => user.login === assignee)) {
    throw new Error("Review issue was not created open and assigned");
  }
  return `Review work created: ${repository} issue ${created.number}`;
}

export function armAutoMerge({
  event, dependencies, gh, shouldClear = false, shouldRouteHeld = false,
  settingsPath = ".github/dependabot-auto-merge.json",
}) {
  const repository = event.repository.full_name;
  const number = event.pull_request.number;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Unreadable pull-request identity");
  }
  const pullRequest = JSON.parse(gh(["api", `repos/${repository}/pulls/${number}`]));
  if (shouldClear) {
    if (!Object.hasOwn(pullRequest, "auto_merge")) {
      throw new Error("Unreadable auto-merge state");
    }
    if (pullRequest.auto_merge !== null) {
      gh(["pr", "merge", String(number), "--repo", repository, "--disable-auto"]);
    }
    return "Prior auto-merge cleared; eligibility must be verified again";
  }
  const { ecosystems } = readSettings(settingsPath);
  const expectedHead = event.pull_request.head.sha;
  const facts = {
    pullRequest, expectedHead, repositoryId: event.repository.id,
    defaultBranch: event.repository.default_branch, dependencies, ecosystems,
  };
  if (shouldRouteHeld) {
    if (!trustedOpenPull(facts) || eligibleUpdate(facts)) return "Not routed: no held trusted update";
    return routeHeldPull({
      repository, number, expectedHead, gh,
      stillHeld: () => {
        const fresh = { ...facts, pullRequest: JSON.parse(gh(["api", `repos/${repository}/pulls/${number}`])) };
        return trustedOpenPull(fresh) && !eligibleUpdate(fresh);
      },
    });
  }
  if (!eligibleUpdate(facts)) {
    return "Not eligible: left for review";
  }
  gh([
    "pr",
    "merge",
    String(number),
    "--repo",
    repository,
    "--auto",
    "--squash",
    "--match-head-commit",
    expectedHead,
  ]);
  return `Squash auto-merge requested for ${repository} PR ${number} at ${expectedHead}`;
}

if (isEntryPoint(import.meta.url)) {
  console.log(
    armAutoMerge({
      event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
      shouldClear: process.argv[2] === "--clear",
      shouldRouteHeld: process.argv[2] === "--route-held",
      dependencies:
        process.argv[2] === "--clear" ? undefined : JSON.parse(process.env.UPDATED_DEPENDENCIES),
      gh: (args) =>
        execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
    }),
  );
}
