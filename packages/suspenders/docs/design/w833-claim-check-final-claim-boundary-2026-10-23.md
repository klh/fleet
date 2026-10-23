# W833.1 — claim-check final-claim boundary

Decision (2026-10-23, W833.1): the done-gate claim-check
(`packages/suspenders/hooks/lib/claim-check.ts` `claimCheckVerdict`) gates
ONLY the final test-pass claim at closure, not every interim utterance.

## Contract

- A test-pass claim needs a passing own run by closure. A later genuine
  own-initiated run corrects an unsupported interim transcript claim:
  the verdict boundary is closure time, so the last run before `work done`
  decides.
- The capsule `--done` text is the final explicit claim. When it claims a
  pass, runs must precede its own timestamp (`capsuleTs`) — later runs
  cannot back a final claim that was already banked. Word capsules without
  claim vocabulary (command + counts, e.g. `bun test x.test.ts → 34/0`) to
  keep the closure boundary at `work done`.
- Run evidence must be own-initiated. Relayed counts (WS-inbox dumps, task
  notifications, unpaired tool results) never satisfy a claim (W917
  origin rule).
- Codex rollout transcripts resolve by exact session id under
  `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*-<sid>.jsonl`
  (`hooks/lib/transcript.ts` `codexRollout`); only a paired
  `exec_command` call whose command directly invokes one test command
  counts as run evidence — relayed or chained output stays foreign.
- Test-affecting files must remain unchanged after the backing run
  (existing mtime + grace check, now anchored on the boundary run).

## Why

The pre-W833.1 verdict walked every claim and demanded a passing run
before EACH one, so one unsupported interim "suite green" utterance voided
closure even when a genuine verified run followed it. The owner asked for
the opposite: interim prose is correctable, final claims are not.

## Where

- `packages/suspenders/hooks/lib/claim-check.ts` — final-claim verdict +
  Codex `response_item` event extraction (`codexInitiatedTest`).
- `packages/suspenders/hooks/lib/transcript.ts` — `codexRollout`
  session-id resolution.
- `packages/suspenders/test/claim-check.test.ts` — boundary, capsule,
  foreign-origin cases.
- `packages/suspenders/test/transcript-resolution.test.ts` — rollout
  resolution + traversal refusal.

## Verification

```
bun test packages/suspenders/test/claim-check.test.ts        34 pass / 0 fail
bun test packages/suspenders/test/transcript-resolution.test.ts   7 pass / 0 fail
bun test packages/suspenders/test/work-completion-record.test.ts 19 pass / 0 fail
qlty fmt --no-upgrade-check <changed files>  &&  qlty check --no-upgrade-check <changed files>
✔ No issues
```
