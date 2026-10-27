# W1838 — `packages/suspenders/deploy/*` is a scanner false positive

## Finding

The `code.dangling-path` event cited merge 043636c6 as having left
`packages/suspenders/deploy/*` missing while
`packages/suspenders/package.json` still references `"./deploy/*"`. The
directory was never dropped:

- `git ls-tree 043636c6 -- packages/suspenders/deploy/` lists the full
  tree (README.md, e2e/, healthcheck/, hub-compose.yaml, hub-deps.ts, …).
- `git ls-tree HEAD -- packages/suspenders/deploy/` lists the same tree;
  the working checkout resolves it too.
- `git log --oneline -- packages/suspenders/deploy/*` shows continuous
  history (last touched by W1469/W1467, no deletion on any ref).

## Why the reference is not dangling

`packages/suspenders/package.json` declares both:

```json
"exports": { "./deploy/*": "./deploy/*", … },
"files": ["hooks", "scripts", "deploy", …]
```

The wildcard export resolves against the directory that exists at the
cited merge and at HEAD, and the `files` allowlist ships it. The scanner
appears to have matched the basename `deploy` heuristically — the same
class as W1806/W1816/W1820–W1834 (`line: 0` event, no concrete reference
site).

## Disposition

False positive; no code change. There is no path to restore and no
reference to rewrite — the export target exists.

## Verification

- `bun test packages/suspenders/test/package-contract.test.ts` — the
  `exports covers every name-based cross-package import` and
  `files allowlist ships the runtime tree` tests (the two that exercise
  the `./deploy/*` export and the `deploy` files entry) pass: 4 pass /
  1 fail, the fail being the pre-existing baseline red in
  `bin matches the installer's PATH shim face` (SHIM_NAMES carries the
  W1354 `prefer` shim; the manifest `bin` map does not) — present with a
  zero-diff checkout, unrelated to this item.
- No repo importers of `@klh/suspenders/deploy/*` exist (`rg` across
  `packages/` and `tests/` is empty), so no import surface to re-verify.
