# Settings grouped controls + JSON routing-policy — W975 record (2026-10-20)

Mission: replace the raw Settings editor with grouped native controls,
preserve all current values, migrate the Suspenders policy view/write to
JSON with atomic conversion, coordinate Belt/Buckle loaders separately
(child W975.1, done).

## What landed

- Suspenders (867f4e09, merged to main via 06cf2b30): the console settings
  surface (`hooks/bin/console-html.ts`, `hooks/board/settings.ts`,
  `hooks/lib/board-config.ts`) now renders grouped native controls —
  Gateway numerics, Model fallbacks as per-model `<fieldset>` tier ladders
  (order = priority, datalist of known tiers), Board numerics/strings,
  the W695.3.2 `<klh-executor-editor>` for agent preference, and On/Off
  selects for the four Orchestrate prompt toggles. Forms prefill from the
  parsed current file; every write previews a diff and confirms.
- Policy view/write is JSON-native: `resolvePolicy` prefers JSON over
  legacy YAML, `policyWritePath` always targets `routing-policy.json`
  (legacy YAML stays a read-only migration source), `policyAsJson`
  converts a legacy document without dropping unrelated keys, and every
  apply rides `atomicWrite` (tmp-in-same-dir + rename, mode 600). The
  runtime JSON materializes on the first operator apply — absent file =
  defaults; the committed YAML default still serves until then.
- Belt + Buckle loaders (W975.1): `belt/bin/router-policy.ts` and
  `buckle/src/policy.ts` accept the JSON policy (YAML as migration input),
  validated + tested separately per package.

## Why

Config-over-code: machine policy is operator data, never code. JSON gives
lossless round-trips (no comment-preserving line-patch needed — the
comment-preserving `patchPolicyText` line editor is retired from the
console path; YAML remains read-only), one write target, and the same
mtime-guarded preview→confirm→atomic-write flow the board settings had.

## Verification

- `bun test test/console-settings.test.ts` (suspenders): 18 pass
- `bun test test/router-policy.test.ts` (belt): 25 pass
- `bun test test/policy.test.ts` (buckle): 7 pass
- Live board `:7799/console/settings`: HTTP 200, all five grouped sections
  render, target shown as routing-policy.json.
