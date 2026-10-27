# @klh/telemetry

Shared telemetry contracts for Fleet services — the headers and formats every
hop agrees on, in one dependency-free package.

## What's inside

`src/` carries six contract modules:

- **hop-contract.ts** — `x-klh-hop-contract`: one bounded wire header that
  carries a request's absolute deadline, remaining attempt budget and the
  visited rung path across Fleet hops, so a Belt→Buckle→Belt→Buckle return
  leg keeps the original deadline/budget/trace and never re-roots. A deadline
  already in the past parses as a distinct `expired` verdict (answered 504 at
  the receiving hop, never clamped forward) — W1086/W1118.
- **http-trace.ts** — shared HTTP trace contract: only opaque IDs and bounded
  diagnostic enums cross service boundaries; prompt and error bodies do not.
- **prefer-header.ts** — bounded, body-free executor intent header
  (diagnostic metadata, not authorization or a router instruction).
- **remote-traces.ts** — one bounded connector for trace receipts held by
  other Buckle hubs; peer addresses and read keys come only from a private
  machine-owned file.
- **trace-log.ts** — bounded, body-free read of Belt's append-only routing
  receipts (a diagnostic connector, not a second routing truth).
- **transport-evidence.ts** — local transport observations
  (`TransportEvidence`); closing a socket is not a provider acknowledgement.

## Use

Import by package name (W1249 import law — never relative reach-ins):

```ts
import { HOP_CONTRACT_HEADER } from "@klh/telemetry";
```

Tests: `bun test packages/telemetry/test/`.
