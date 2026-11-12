# Canonical benchmark log

Every benchmark agent must update **both** `benchmarks.json5` and
`benchmark.md` in the same commit. Put factual notes in the JSON node/run
and its linked Markdown page; `render` derives the Markdown from those notes.

- Add one leaf per actual execution. Stable IDs prevent duplicate imports.
  Planned/unadmitted work is a note, not a fabricated run.
- Distinguish independent attempts, same-conversation continuations, judge
  replays and expected-negative controls. Link replays/continuations to their
  producer; they do not increase fresh-generation reliability.
- Retain failures, invalid/exposed trials and incomplete lifecycles. Unknown
  measurements are `null`, never zero. Record timing/accounting scope.
- `winner` stays `null` without valid matched quality evidence. A promising
  adaptive screen or repeated grading of one patch is not a reliable winner.
- Keep credentials, private judge contents, journals and private HOST paths
  out. Preserve original evidence hashes; label sanitized/external evidence.
- `benchmark.md` is only the top-node link/winner/run/failure table. Detailed
  history belongs in the linked nodes; archived prose is not invented leaves.

From the repository root, run `bun packages/blam/tools/benchmark-log.ts render`
then `bun packages/blam/tools/benchmark-log.ts check`. Commit both canonical
files and the changed node notes. The checker performs no benchmark execution.
