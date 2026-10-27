# W1795 — `packages/suspenders/scripts/routing-policy.json` is a scanner false positive

## Finding

`packages/suspenders/scripts/routing-policy.json` never existed in git history
(`git log --all -- <path>` is empty on every ref; absent from both parents of
merge 85576d93). The merge dropped nothing.

## Why the references are not dangling

`packages/suspenders/scripts/install-llm-steps.ts` mentions
`"routing-policy.json"` in two places; both join the bare literal onto a
runtime home, never onto the script's own directory:

1. `GENERATOR_INPUTS` (line ~111) — entries are joined onto `ctx.llmHome`
   (`gatewayConfigStale`, `join(home, name)`), the machine-level
   `~/.claude/local-llm/` runtime copy. The committed default that seeds it is
   `packages/buckle/routing-policy.json`, which exists.
2. The stub table (line ~401) — `"routing-policy.json"` is the TARGET name in
   `ctx.llmHome`; its SOURCE is `join(beltBin(ctx), "../../buckle/routing-policy.json")`
   = `packages/buckle/routing-policy.json` (the W284/W1253 committed monorepo
   default, present).

So there is no repo path to restore and no reference to rewrite.

## Disposition

False positive; no code change. The scanner resolves bare relative literals
against the referencing file's directory (`resolveLiteral`), which cannot see
the `ctx.llmHome` / `beltBin(ctx)` joins at these two sites. Per sibling
precedent (W1791/W1798): the runtime-home and belt-kit join targets are the
real resolution, and `packages/buckle/routing-policy.json` is the committed
source of truth.

## Verification

- `packages/buckle/routing-policy.json` exists on HEAD.
- Focused suites: `w1302-merge-dangling` and `install-llm-steps` green
  (counts in the item close summary).
