# OpenRouter docs scout — decomposition plan (W2619, 2026-11-03)

Owner directive: read the three OpenRouter doc surfaces fully and LIFT
what matters into buckle / suspenders / fleet — as direct-referenced work
items, dispatched after the v2.1.4 hub relaunch is deployed and verified.

This item is the decomposition plan: it enumerated the trees, armed three
child lanes (one per surface), and held them for the owner's sequencing.
The children carry their own page inventories and reconcile targets in
their work-graph descriptions; this doc is the receipt.

## Enumeration receipt

Live index fetch: `https://openrouter.ai/docs/llms.txt` (2026-11-03),
plus the bundle indexes `/_llms/docs.txt` (156 pages) and
`/_llms/api-reference.txt` (161 pages). Fetched as plain `.md` URLs —
first-tier doc reads, not training data.

| Surface                                 | Size (from llms.txt)                                               | Child item |
| --------------------------------------- | ------------------------------------------------------------------ | ---------- |
| Agent SDK (`/docs/agent-sdk/…`)         | 21 pages (callModel tree + examples + dev-tools)                   | W2619.2    |
| API reference (`/docs/api_reference/…`) | 161 pages, ~40 endpoint groups                                     | W2619.3    |
| Cookbook (`/docs/cookbook/…`)           | quickstart + coding-agents / building-agents / administration rows | W2619.4    |

Fleet reconcile anchors already in hand (from W2597 org scout,
`docs/scout-openrouterteam-w2597.md`): doom-loop semantics →
`hooks/lib/gates/runaway.ts`; toolcall-schema-fuzz → buckle adapter
conformance; Switchyard latch → W2593 kev sentinel. The children extend
these with the doc-tree axes: stop-conditions vs lane caps, limits/error
taxonomy vs buckle cooldowns, Responses-API pages vs W2583, presets vs
`upstreams.json` groups, cookbook lane patterns vs dispatch lanes.

## Dispatch sequencing (owner law)

All three children are minted and HELD (`work wait`, kind=external):
dispatch only after v2.1.4 is deployed and verified (W2596 owns the
release). Wake verb for the dispatcher: `work wake W2619.2 W2619.3
W2619.4`, then one lane each, model pinned glm-5.3 (owner instruction).

## Deliverable shape (identical across children)

`docs/scout-openrouter-<surface>-<id>.md` — decision-grade verdict table
(LIFT clean / ADAPT pattern / SKIP-with-reason per row), direct URL per
row, license note per page footer (site claims Apache-2.0; verify on
read), reconcile column naming the fleet file that already covers the
ground or the gap it fills.
