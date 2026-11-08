# Measured Pi/runner comparisons

This additive BLAM track reuses `pairedLift` and `gatePromotion`; it does not change a seed channel or deploy a runtime. Infrastructure-only runs and agentic runs are explicitly different tracks.

Run `bun packages/blam/bench/runner/workspace-smoke.ts /tmp/blam-run-unique 12` for a local, model-free workspace probe. Both arms use the same resident Git fixture (128 files), alternating clone-first and worktree-first order. Baseline is `git clone --no-hardlinks`; candidate is a detached worktree sharing Git objects. Exact file content is the acceptance check. These are workspace strategies, NOT isolated sandboxes, Pi sessions or token-efficiency evidence. OS page caches are uncontrolled and explicitly labelled. This probe never contacts a model.

Replay any compatible experiment with `bun packages/blam/bench/runner/report.ts /path/to/receipts.ndjson`. Stdout is one JSON record; diagnostics use stderr. Invalid experiments exit 2. A valid experiment may refuse promotion without being malformed. Output files are exclusive-create, mode 0600, and never overwrite an earlier run.

`contracts.ts` is the Zod wire contract. Each record identifies experiment, track, arm, zero-based contiguous repetition, within-pair order, seed/config digest, fresh job identity, setup identity, measured durations, memory/disk if measured, model usage if observed, validation quality, exit/timeout/isolation outcomes and evidence/artifact digests. Setup identity fixes task, repository, host, runtime, model, provider, cache condition, policy, dependency set and private judge. Change one lever through the arm's seed/config digest. Different hosts/providers/tasks require separate experiments, not pooled lift.

Agentic usage uses input INCLUDING cached input, separate cachedInput (a subset), and output. Normalise provider accounting before emitting. Missing measurements are null. Agentic runs require positive usage and measured isolation outcomes; infrastructure runs may leave these null and can never claim token savings. Never count a simulated fixture's tokens as measured model usage.

Each pair must have one baseline and one candidate with unique job identities. Even repetitions run baseline first, odd repetitions candidate first. Mixed setups, changed seeds within an arm, missing arms, missing startup observations, execution/isolation failures and failed candidate validation refuse promotion. Fewer than 12 pairs cannot promote. A positive mean also needs majority sign agreement for the improved timing/token metric. Report p50/p95 and missing counts; twelve runs are a speed smoke, not broad agent-quality evidence.

External runtime producers must retain raw observations and keep the private validator outside the agent workspace. `quality=1` means its acceptance checks passed, not an agent's self-assessment. The evaluator validates supplied receipts, not their provenance: a benchmark owner must bind receipts to trusted measurement and judge artifacts before acting on its advice.

Compare rootless containers, prepared seeds, warm pools and VM snapshots only on hosts that actually support them. Keep true-cold image pull separate from matched resident-image runs. Keep cache-warm and cache-cold inference separate; a session fork does not imply provider cache reuse. Record failure/uncertain outcomes instead of dropping slower or failed pairs.

Run focused checks: `bun --bun node_modules/.bin/playwright test --config packages/blam/test/playwright.config.ts runner-evaluation.e2e.ts runner-cli.e2e.ts`. Real model and remote-host measurements belong in live opt-in runs; the core tests are credentialless. Curated results go to root `benchmarks.md`; negative results go to root `doesnt_work.md`.
