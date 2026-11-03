# `review/gate` is red

## What you see

A pull request's `review/gate` check has failed. Its one-line description says why; the common
ones are:

| Description starts with                                         | Meaning                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `no readable Lane declaration (treated as guarded): no reviewer verdict names head …` | The body has no usable `Lane:` line, so the change is treated as guarded, and it has no approval. |
| `guarded: no reviewer verdict names head …`                     | Declared guarded; `toddreviewer01` has not approved this exact head.                            |
| `<file> is guarded surface; guarded: …`                         | Declared ordinary, but it changes a file on the project's guarded surface.                       |
| `guarded: reviewer requested changes on head …`                 | `toddreviewer01`'s latest verdict on this head asks for changes.                                 |
| `ci-only: no readable Lane declaration`                         | The project uses `ciOnly`, and the body has no usable `Lane:` line.                             |
| `head belongs to … open pull requests`                          | A review arrived for a head that two or more open pull requests share.                          |

## Why it happens

The gate is green only when the change's consequence allows it. An ordinary change needs no
reviewer; a guarded one needs `toddreviewer01`'s approval of the exact current head. Red means
neither is true yet. Required CI is a separate check, so a red gate says nothing about tests.

A `Lane:` line is usable only if it is the **only** `Lane:` line in the body (outside HTML
comments and above a `<!-- codesmith:footer -->` line), and its value starts with exactly
`ordinary` or `guarded`, followed by the end of the line, a space, a comma or `(`. So
`Lane: guarded (touches the gate)` is fine, while `Lane: guarded/ordinary`, `Lane: ordinary-x` or
two `Lane:` lines are undeclared.

A new push needs a new approval. An approval carries to a later head only when that head does
nothing but merge the base branch into the approved one, which the gate proves by comparing the
git trees.

## What fixes it

- **No usable `Lane:` line:** edit the pull request body so it has exactly one, such as
  `Lane: ordinary`. Editing the body re-runs the gate.
- **Guarded, no approval yet, or changes requested:** the change needs `toddreviewer01`'s review of
  its current head. In a lane, that is `ws review start` and `ws review wait` (the
  `guarded-review` skill). When the reviewer approves, the gate re-runs on its own.
- **Ordinary, but it touches the guarded surface:** it is guarded. Either get the review above, or
  take the change to that file out of this pull request. Do not remove the file from
  `.github/review-gate.json` to get past it: the settings file is guarded itself, and the gate
  reads it from the default branch, not from the pull request.
- **Head shared by several pull requests:** close the duplicate, then push or edit the remaining
  one.
