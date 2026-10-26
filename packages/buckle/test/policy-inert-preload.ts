// test/policy-inert-preload.ts — W1265.2 harness posture: the mandatory
// general default must not flip on inside server-spawning suites whose
// fixture rows are dialect-only (no adapter in the default allowlist) —
// they test gate/auth semantics, not the account boundary. Fill-only: a
// suite or operator that sets BUCKLE_REPO_TIER_POLICY (or passes an
// explicit accountPolicyPath with the env already set) keeps its value,
// and boundary suites inject docs via testDeps — env is never read there.
process.env.BUCKLE_REPO_TIER_POLICY ??= "off";
