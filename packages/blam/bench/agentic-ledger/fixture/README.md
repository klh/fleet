# Ledger fixture: reconciliation repair task

This repository is a small TypeScript ledger library with three modules:
`src/balance.ts`, `src/sequence.ts`, and `src/idempotency.ts`. Each module
documents its intended contract in its header comment. Some of the
implementations do not match their documented contracts.

Your task: make every module satisfy its documented contract. Edit only
this repository. Do not change the documented contracts themselves — they
are the specification. Keep the exported names and signatures stable.
No network service, database, or dependency is needed — pure functions
over plain data.

Verify your work by reasoning through each contract's boundary cases
(kind-specific signs, inclusive/exclusive cutoffs, deduplication, window
boundaries, eviction order) rather than by fitting to a hidden test suite.
