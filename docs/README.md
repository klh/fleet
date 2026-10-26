# Fleet documentation map

Start with the [repository README](../README.md) and [engineering laws](../AGENTS.md).
The work graph (`work show`, `work ready`) is the current task ledger; dated
documents below are evidence from the commit or date named in each record.
Check current code and the work graph before acting on an old recommendation.

| Need | Start here | Related evidence |
| --- | --- | --- |
| Current restructuring direction | [Restructure proposal](restructure-proposal-2026-10-23.md) | [PaaS standard](paas-engineering-standard-2026-10-23.md), [standard dispositions](standard-dispositions.md), [entry-point and import map](fleet.entry-points.map.md), [layout convention](layout-convention.md) |
| Avoid repeated owner corrections | [Owner-correction taxonomy](owner-correction-taxonomy.md) | [Corpus audit](md-corpus-audit-w693.md) |
| Documentation overlap | [W1282.1 consolidation receipt](docs-consolidation-w1282-1.md) | Duplicate clusters, retained evidence, and link check |
| Install and lifecycle | [Install e2e receipt](install-e2e-2026-10-19.md) | [Clean install](clean-install-w422.6.md), [lifecycle contract](lifecycle-launch-contract.md), [health contract](health-status-contract.md) |
| Routing and Buckle | [Buckle and LiteLLM review](litellm-behind-buckle-review.md) | [Upstream observability](upstream-observability-architecture.md), [bridge parity decision](decision-w883-bridge-parity.md), [Z.ai pressure evidence](w1257-zai-pressure-evidence.md) |
| Coordination and identity | [Cross-hub identity](cross-hub-project-identity.md) | [Enrollment pilot](identity-enrollment-pilot.md), [control-chain review](control-chain-review-2026-10-07.md) |
| Enterprise boundaries | [Enterprise posture](enterprise-posture-audit.md) | [Gap review](enterprise-gap-review-w688-2026-10-12.md), [policy tier](decision-w775-policy-tier.md), [packaging](enterprise-packaging-v0.md) |
| UI and observability | [GUI observability](gui-observability-review.md) | [GUI redesign parity](gui-redesign-parity.md), [dashboard KPI audit](w858.4-overview-kpi-audit.md) |
| Evaluation and research | [Harness self-improvement](harness-self-improvement.md) | [Evaluation protocol](w960-eval-protocol.md), [research synthesis](research-toto-gpt.md) |

## Related records that should be read together

| Record set | How to use it |
| --- | --- |
| [Monorepo setup audit](monorepo-audit-2026-10-05.md), [integration review](monorepo-review-2026-10-05.md), [cutover record](monorepo-cutover-record.md) | Same migration period, different evidence: initial audit, reproduced installed failure, then cutover. The [corpus audit](md-corpus-audit-w693.md) checks later landing status. Do not treat the original findings as a current defect list. |
| [Failed backlog triage](failed-backlog-triage-2026-10-12.md), [W785 sweep](w785-skipped-postponed-forgotten-sweep-2026-10-18.md), [W782 sweep](review-w782-skipped-sweep-2026-10-19.md), [W805 close record](stale-failed-close-sweep-2026-10-18.md) | Chronological snapshots and closure evidence. Use `work show <id>` for current state; do not remint from an old snapshot. |
| [Parked-branch audit](parked-branch-audit-2026-10-07.md), [disposition](parked-branch-disposition-2026-10-19.md) | Discovery and later classification; verify refs and merges before cleanup. |
| [Enterprise packaging proposal](enterprise-packaging-v0.md), [W688.4 verification](enterprise-packaging-w688-4-record.md) | Proposed product boundary and a later implementation receipt. |

The `decision-*`, `record-*`, `review-*`, `w*`, and dated research files are
historical records. Their titles identify the item or date; they remain in
place so existing links, exact evidence, and the sequence of decisions survive.
Only a new verified record should supersede one. This map provides navigation,
not another mutable status ledger.
