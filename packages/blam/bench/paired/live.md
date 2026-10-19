# Live paired harness evaluation

The live runner compares two harness instructions on one coding task. It
checks out the same `baseRef` commit for each arm in a disposable Git
worktree, alternates arm order, and runs one identical executor command
with `{prompt}` expanded to the task plus the selected harness text.
`{model}` and `{worktree}` are available in argv. The judge runs after
the executor and cannot receive `{prompt}`. Put its private rubric and
fixtures outside the evaluated repository; the agent may otherwise read
them. The output directory must also be outside that repository.

Example manifest for an isolated fixture repository:

```json
{
  "repo": "/path/to/evaluation-fixture",
  "baseRef": "HEAD",
  "task": "Implement the specified function. Edit only the fixture repository.",
  "model": "your-pinned-model",
  "baseline": "Follow the task and run the relevant tests.",
  "candidate": "Inspect the failing case, write the smallest fix, run the relevant tests, and record any remaining uncertainty.",
  "reps": 3,
  "executor": ["codex", "exec", "--json", "--model", "{model}", "--cd", "{worktree}", "--sandbox", "workspace-write", "{prompt}"],
  "judge": ["bun", "/path/outside/evaluation-fixture/judge.ts", "{worktree}"],
  "timeoutMs": 600000,
  "outputDir": "/path/to/evaluation-results"
}
```

Run `bun packages/blam/bench/paired/live.ts /path/to/manifest.json`.
The result is `report.json` and one binary Git patch per arm and
repetition. The report includes a SHA-256 of the manifest, the exact
base commit, model label, per-arm lane ID, harness digest, exit status,
validation result, executor time, judge time, observed tokens, and
output digest, plus failed-validation counts per arm. The common
`pairedLift` and `gatePromotion` functions
make the decision. The runner never promotes a harness automatically.

Use a pinned model and identical agent settings, tool access, budgets,
and validation across arms. The manifest keeps executor argv identical
and alternates order; it cannot prove provider routing or prevent an
agent from accessing files outside its worktree. Use an external sandbox
and private judge storage when that matters. Token counts come from the
executor's reported usage; if accounting is absent, promotion is
refused. Wall time covers the executor, with judge time recorded
separately. Patches can contain task data, so treat the output directory
as private and do not commit it.
