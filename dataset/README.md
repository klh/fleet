# BLAM dataset

`incidents.jsonl` — one JSON object per line, validated against
`schema/incident.schema.json`. Seed set: 10 sanitized incidents from a
production single-machine fleet (2026-08 → 2026-09), plus one external
corroboration record (METR 2026-08-26).

- Class distribution: C=3, R=4, S=2, H=1
- Sanitization rules: `docs/labeling-protocol.md` § sanitization
- Agreement protocol: κ target ≥ 0.7 on a 25% second-annotator sample
- License: CC-BY-4.0

## Adding records

Append one JSON object per line (any order; ids are the keys), then:

    bun tools/label.ts validate

Records that fail validation are rejected at commit time by the repo gate.
