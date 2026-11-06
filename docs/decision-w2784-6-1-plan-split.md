# W2784.6.1.1 — plan: W2269.1.4 Lit migration scopes 1-4 split

W2784.6.1 ("W2269.1.4 Lit migration scopes 1-4, needs plan-split into 4")
registered this plan item and split into four independently-scoped children
via `work split W2784.6.1 ... --reason independent-scopes --keep 1 --plan
W2784.6.1.1`:

| child       | scope                                                         | result sha |
| ----------- | -------------------------------------------------------------- | ---------- |
| W2784.6.1.2 | console-html.ts — executor editor to ElementInternals            | `beab3470` |
| W2784.6.1.3 | usage-page-html.ts + usage-chrome.ts — tokens                    | `43af8e3a` |
| W2784.6.1.4 | federation-usage-html.ts + federation-work-html.ts                | pending    |
| W2784.6.1.5 | hub-admin-html.ts (merge origin/main → suspenders/W2269.1.4)      | pending    |

Context: the umbrella W2269.1.4 slice landed (result_sha `4e3136fb`) but was
never merged to main — each child reconciles its unmerged content with the
current main tree rather than redoing the migration from scratch.
