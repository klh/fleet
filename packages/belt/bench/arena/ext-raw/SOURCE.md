# ext-raw — byte-exact external source snapshots

Fetched copies of the public sets the ext slice was sealed from. Never edit;
the ext MANIFEST pins sha256 + provenance for every file here.

- `frames-test.tsv` — google/frames-benchmark `test.tsv` (FRAMES: Factuality,
  Retrieval And reasoning MEasurement Set, arXiv 2409.12941), fetched from
  https://huggingface.co/datasets/google/frames-benchmark/resolve/main/test.tsv
  at HF repo revision `58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef` (2024-10-15),
  license Apache-2.0, 824 QA rows with answers, 484887 bytes,
  sha256 `4255093c93b595b5b04c7c8dde290b48ec87d72ca0fb0b760d9dd02740d669ff`.
  Public since 2024-09 →
  CONTAMINATION: treat as directional, never leaderboard-grade (same class
  caveat as GAIA 2023 / WebWalker 2025).

GAIA, WebWalkerQA and SealQA were evaluated as slice sources and are NOT
bundleable from here: all three are auth-walled on the Hub without accepting
their gates (GAIA additionally forbids resharing outside gated/private repos),
so the harness seals from FRAMES and carries the same task class: multi-hop
search questions with short verifiable answers, scored EM + LLM-judge.
