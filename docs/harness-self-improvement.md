# Harness self-improvement

Fleet's BLAM loop improves the shared lane-orientation instructions with fixed
model weights. A model proposes an instruction change, BLAM probes it against
the current task without a private judge, and the model composes a revision
from the two execution receipts. The revised instructions then face at least
130 distinct held-out tasks for automatic promotion. Each task runs baseline and candidate from the
same commit with the same executor and a private judge. Only a complete,
non-regressing measured lift may enter the versioned starter registry.

The first editable component is the starter's `instructions` field. This is
the component dispatch can actually consume and roll back today. Scripts,
plugins, tools, and skills require separate capability and permission gates
before they can be made editable. The loop never edits tracked files.

The improvement log is append-only under the project's untracked `.fleet`
directory. An accepted lesson carries its BLAM evidence digest into the next
run's editor context. Rejected candidates remain in the run receipt but are
not treated as lessons. A promoted starter is immutable; rollback revokes it
and restores the previous version. Lane startup reads the newest valid
`lane-orientation` artifact and seeds a new versioned session when its content
changes. It applies guidance only to compatible models. If no compatible
artifact exists, it uses Fleet's built-in prompt.

The editor is an argv command supplied in runtime configuration. It receives
`{prompt}` and `{model}` and must print one JSON object containing
`instructions` and `lesson`. BLAM validates size and secret rules before any
probe. The executor and private judges are also argv arrays. The manifest,
judge files, output directory, and generated patches stay outside the agent's
task worktree. At least three different held-out tasks are required. A run
cannot promote when usage is absent, a command fails, a candidate fails any
judge, or the measured promotion gate refuses it. Held-out evaluation stops at
the first failed or unmeasured pair; that candidate cannot promote.

This is a bounded, sequential Propose-Probe-Compose implementation inspired
by Harness². It is not a model-weight training mechanism, and it does not
claim improvements for components that Fleet does not load at runtime.

## Run

Grant the runner's actor promotion permission in the target project's runtime
`.fleet/starter-registry/authz.json`. If no `lane-orientation` artifact exists,
the first run compares against Fleet's built-in prompt and may create version
1. The private judges and output directory
must be outside all evaluated repositories. Run:

```text
bun packages/blam/bench/improve/loop.ts /absolute/path/to/manifest.json
```

The manifest has `starterRepo`, `starterId`, `actor`, `model`, `editor`,
`executor`, `probe`, `heldout`, `steps`, `timeoutMs`, and `outputDir`. `editor`
is an argv array with `{prompt}` and optional `{model}`; it returns JSON with
`instructions` and `lesson`. `executor` uses the same argv and model for both
arms and must report token usage in the format accepted by BLAM's paired
runner. A task has `id`, `repo`, `baseRef`, and `task`; each held-out task also
has its private `judge` argv. Three held-out tasks with different IDs and task
texts are the minimum for a pilot; automatic promotion needs 130, following
Fleet's quality-sample rule. `steps` is 1 through 3. The command prints the
promotion verdict, new starter version if any, and the report path. Each run
gets its own output subdirectory so old receipts are never overwritten.

The editor should be configured to use the Fleet-controlled model route. Its
proposal and composition are untrusted until the held-out gate passes. Keep
the held-out task statements, judges, and patches private, and audit that
the chosen executor cannot read judge files. The test fixture exercises the
gate and runtime starter lookup without spending model tokens; a production
quality claim requires a live run on representative tasks. The report records
editor wall time, but editor tokens remain unknown with the plain-text editor
adapter. The promotion gate compares per-task execution tokens and time; it
does not yet amortize the one-time cost of generating a candidate.
