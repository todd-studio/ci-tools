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

export function eligibleUpdate({
  pullRequest,
  expectedHead,
  repositoryId,
  defaultBranch,
  dependencies,
  ecosystems,
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
    pullRequest.commits === 1 &&
    pullRequest.head?.sha === expectedHead &&
    pullRequest.head?.repo?.id === repositoryId &&
    pullRequest.base?.repo?.id === repositoryId &&
    pullRequest.base?.ref === defaultBranch &&
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

export function armAutoMerge({
  event, dependencies, gh, shouldClear = false,
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
  if (
    !eligibleUpdate({
      pullRequest,
      expectedHead,
      repositoryId: event.repository.id,
      defaultBranch: event.repository.default_branch,
      dependencies,
      ecosystems,
    })
  ) {
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
      dependencies:
        process.argv[2] === "--clear" ? undefined : JSON.parse(process.env.UPDATED_DEPENDENCIES),
      gh: (args) =>
        execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }),
    }),
  );
}
