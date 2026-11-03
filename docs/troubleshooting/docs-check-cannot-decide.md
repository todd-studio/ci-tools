# The docs check says "cannot decide"

## What you see

The docs check (`docs-parts.mjs`, often run through a project's `scripts/docs-parts.sh`) exits 2
with a line like:

```text
docs parts: cannot decide — <reason>
```

Exit 2 is neither a pass nor a finding. The check could not establish an answer, and it refuses
to report one rather than pass by default. A finding, by contrast, is exit 1 with lines starting
`RED`.

## Why it happens, and what fixes it

The reason after the dash names the cause:

| Reason                                                                         | What fixes it                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cannot load acorn …` or `cannot read <file> as TypeScript — run npm ci …`                            | The parsers are not installed beside the check. Run `npm ci --ignore-scripts` in the folder holding `docs-parts.mjs`, `code-links.mjs`, `package.json` and `package-lock.json`.        |
| `no docs-site/parts.json under <dir> — --require-registry …`                   | `--root` points at the wrong folder, or the registry was deleted. Pass the project's root.                                                                                           |
| `docs-site/parts.json is unreadable: …` or `… is not a list of parts with id, source and owns` | Fix the JSON so every part has `id`, `source` and an `owns` list.                                                                                                       |
| `docs-site/parts.json exists but docs-site/boundaries.json does not`           | `boundaries` needs its rules file; a missing one would switch the check off. Add `docs-site/boundaries.json`.                                                                        |
| `docs-site/boundaries.json: …`                                                 | A boundary rule is missing its `id`, `text` or `kind`, or a field has the wrong type. The message names the rule.                                                                    |
| `git … failed: …`                                                              | Git could not answer, often because `--base` names a ref the checkout does not have. Fetch it (in CI, check out with enough history) and run again.                                   |
| `answer needs --base`, `answer needs exactly one of --body-file, --body-env`, `unknown argument …` | The command line is wrong. The README lists each command's arguments.                                                                                      |
| `<page>: a code-link fence is never closed`                                    | A `code-link` block on that page has no closing fence. Close it.                                                                                                          |

Through workstation's `scripts/docs-parts.sh`, a bundle that cannot be fetched, verified or
installed is also exit 2, with a line starting `docs-parts:` that names the problem.
