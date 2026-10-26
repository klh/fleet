# W996 settings forms — duplicate closure (2026-10-20)

W996 requested grouped, labeled, validated Settings controls and JSON policy
writes. [W975](decision-w975-settings-json-policy.md) had already delivered
that scope at `867f4e09` (merged via `06cf2b30`), so W996 closed with no code
change. W975 retains the implementation and 18/25/7 focused test receipts.

The W996 verification additionally checked that invalid input is rejected by
`validateBoardSettings` before writing, secrets stay in 0600 operator files,
and legacy YAML remains a read-only source until the first JSON apply. Those
claims describe the 2026-10-20 snapshot; inspect current code before relying
on them operationally.
