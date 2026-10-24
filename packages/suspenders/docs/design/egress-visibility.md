# Egress visibility — selective request visibility and connection reconciliation (W1264.2)

One model for what the fleet can honestly see of AI egress, plus the
reconciliation that keeps tunnel and gateway counts honest. Two laws bind
the design:

1. **Catalog boundary (owner, 2026-10-24)** — cross-tool detection and
   installation ride the vendored skills catalog and its capability model
   (`hooks/lib/targets.ts`, `hooks/lib/vendor/skills-agents.ts`,
   `fleet-install.ts`). The egress layer adds ONLY Buckle-route
   configuration adapter metadata atop that model. No scanner, no
   installer, no duplicated target list; a GUI app outside the catalog is
   transport-observed, never fake-installed.
2. **Never equate CONNECT to L7 API calls** — a transport-tier row counts
   as transport only. The `request` tier requires a verified Buckle route,
   operator-deployed trust, AND an unpinned destination.

## Visibility tiers (`hooks/lib/egress-visibility.ts`)

| tier                | meaning                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `request`           | decrypted, request-aware observation at the trusted Buckle route     |
| `transport`         | opaque TLS through the tunnel: addresses + byte counts only          |
| `pinning-fallback`  | trusted route, but the destination pins certs — TLS left end-to-end  |
| `unattributed`      | seen at the tunnel; no catalog/process attribution — never guessed   |

Trust evidence (`EgressTrustSource`) is three distinct gates, never merged:
`requestCapableApps` — documented endpoint-override capability (owner-
verified research 2026-10-24: claude-code, codex, grok Build,
github-copilot/VS Code; native ChatGPT and Claude chat document only
transport-proxy / MCP-connector routes and stay transport forever);
`verifiedRoutes` derives from the W918 catalog table (`targets.ts`
`VERIFIED_BUCKLE_ROUTES`, one source of truth); `trustedApps` +
`pinnedDestinations` are operator config-over-code. The honest default
trusts nothing: until config deploys trust, even capable, verified targets
classify as `transport`. Capability ≠ trust ≠ a verified route.

## Reconciliation (`hooks/lib/egress-reconcile.ts`)

`reconcileConnections(tunnel, gateway)` joins the Sing `/connections`
index (W1260.1 owns the live producer) with the Buckle request index
(W1259 owns the live producer) by unique id only — the gateway row's
`tunnelConnId` vs the tunnel row's `id`. No host/time heuristics; a
decoded LLM request is NEVER inferred from a CONNECT socket or an MCP
call. One tunnel connection may carry many requests (HTTP/2
multiplexing), so

## Reconciliation (`hooks/lib/egress-reconcile.ts`)

`reconcileConnections(tunnel, gateway)` joins the Sing `/connections`
index (W1260.1 owns the live producer) with the Buckle request index
(W1259 owns the live producer) by unique id only — the gateway row's
`tunnelConnId` vs the tunnel row's `id`. No host/time heuristics. One
tunnel connection may carry many requests (HTTP/2 multiplexing), so
`matchedTunnel` and `matchedGateway` are reported per source and are never
assumed equal; unmatched rows stay per-source (`tunnelOnly` /
`gatewayOnly`). `summarizeReconciliation` folds coverage: per-tier counts
over tunnel rows, while `requestAware` counts only gateway rows with their
own model metadata.

## Tests

`test/egress-visibility.test.ts` + `test/egress-reconcile.test.ts`
(18 tests): tier matrix, pinning fallback and label-boundary matching,
catalog-breadth adapter metadata, strict-id join, multiplexing count
divergence, and the never-promote law.
