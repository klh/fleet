# Optimization contracts

These modules define the host-side boundary for reusable BLAM experiments.
Historical-case mining and off-hours campaign execution are separate
consumers. A schema-valid record is not an independently verified result.
Only trusted host adapters may create evidence; they must verify the
referenced files, provider audits and cleanup operations before doing so.

- `cases.ts`: pinned repository/environment identity and repeated stable
  failing-base/passing-fix controls. `publicTask` selects the task context
  without exposing reference revisions or evaluator arguments.
- `layout.ts`: admit existing, pairwise-disjoint candidate/oracle/output
  directories using both declared and canonical paths. Oracle/output
  roots must be private to the host owner. Call this before materializing
  an executor manifest; it does not replace the execution sandbox.
- `strategies.ts`: declared materialized arm settings and deterministic
  digest. Runtime fingerprints include resolved configuration; harness
  fingerprints identify the exact instructions used for this case.
- `evidence.ts`: assess target/regression quality only after identity,
  positive usage, effective settings, route, patch and cleanup checks.
  Transport, harness, cancelled, censored and unsupported outcomes remain
  distinct from incorrect patches. Unknown evidence stays ineligible.
- `protocol.ts`: NDJSON lifecycle and recommendation records. Three fresh
  confirmations and distinct held-out cases are necessary metadata; the
  campaign must establish them from the complete hashed attempt history.
  A recommendation cannot activate itself.

The existing paired runner exports the shared runtime manifest/receipt
schemas from `bench/paired/contracts.ts` and preserves its TypeScript API.
Executor/judge isolation still requires a real sandbox and private oracle
storage. These contracts do not grant capabilities or create isolation.
