# W694 — adversarial repo review: laws vs reality (2026-10-12)

Read-only review of klh/fleet at 2fad9810. Every finding was probed against
real code or a temp repo; nothing was fixed. Literal hosts, IPs, MACs and user
paths are deliberately described, not quoted (scrub gate).

Verdict: FAIL. Two HIGH findings: scrub bypasses, W690 pin gate bypass.

## HIGH

### H1 — scrub gate is blind to merge commits and the merge ladder never scrubs

- `packages/suspenders/hooks/bin/scrub-gate.ts` `stagedFindings`: `git diff --cached -U0`
  is empty for a merge commit, so a leak re-added by a merge resolution is invisible.
- `packages/suspenders/hooks/lib/merge-guard.ts` `validateTree` runs conflict-marker
  and syntax checks only (no scrub); publish is `merge --no-ff` in a scratch worktree
  then `--ff-only`, so the Bash gate never sees it.
- Probe: temp repo, merge commit carrying a `/Users/<name>/...` line, scan = clean.
- Impact: a laundered path/key lands on main without a deny.

### H2 — scrub gate range and parser holes (all probe-confirmed)

- `scrub.ts` `addedDiffLines` drops any raw diff line starting `+++ `; an added
  content line whose text begins `++ ` is silently skipped (probe4: 1 of 2 leaks missed).
- `scrub-gate.ts` `pushFindings` returns `[]` with no upstream; `hookPushFindings`
  for a zero remote sha falls back to it. New-branch first push = unscanned.
- Push range is net `remote..local` tree-diff: add-then-remove inside the range is
  never flagged though the leak is in pushed history (probe2 S1).
- Binary / NUL-byte files skipped wholesale.
- `.githooks/*` are fail-inert when bun/script is absent and `core.hooksPath` is
  not set by default; `SUSPENDERS_SCRUB=0` disables everything.
- CI (`.github/workflows/ci.yml`) has no scrub or gitleaks job: nothing server-side.

### H3 — W690 pin skips the cloud gate (`packages/buckle/src/decide.ts` ~109)

`pinnedRows = candidates.filter(group === pin)` is used without `viable()`.
A pinned cloud group with `allow_cloud:false` (probe C) still selects a cloud head
for plain and `prefer` hints; `router.ts` `walkSelected`'s `demanded` path also
bypasses `mayEscalate`. Impact: cloud spend/egress when the operator gate is closed.

## MEDIUM

- M1 — `decide.ts`: with `allowCross`, pinned other-dialect rows are in `scoped`
  AND pushed again, so `ordered`/`seen` are inflated and attempts duplicate (probe A).
- M2 — `decide.ts`: `allowCross:false` (count_tokens, `handlers.ts` proxy) does not
  restrict a pin to the request dialect; an unbridgeable row becomes head (probe B)
  while the unpinned identical request returns an error.
- M3 — `decide.ts`: unhealthy pinned rows are still head (probe D); `must` hint
  vs pin conflict has no defined error (probe E).
- M4 — `packages/buckle/test/decide.test.ts` has zero W690 pin tests; helper omits `group`.
- M5 — `packages/belt/bin/dashboard.ts` lines 472/499/517 use `innerHTML` in the
  inline script (UI law: never). Mitigated by `esc()` (line 392) but the law has no
  exception. The UI-law gate (`hooks/gates/files.ts:61-75`) only fires on Write/Edit
  payloads, so existing violations and shell-written files are unchecked; CI has no
  innerHTML job.
- M6 — `packages/suspenders/pages/index.html:340` imports mermaid from a CDN
  (Lit/offline-LAN law: never CDN).
- M7 — config-over-code: `packages/belt/bin/gateway.ts:12` and `gateway-config.ts:18`
  default HOME to a hardcoded user dir; `spikes/w86/wake.ts:10-11`,
  `remote-provider.ts:38,42`, `sim/ikea-pilot.ts:181`, `e2e/hub-board.spec.ts:70`
  hardcode the NAS LAN IP, NAS MAC and NAS hostname. The builtin scrub rule set
  has no MAC / RFC1918 rule, so only the machine-local denylist (not committed,
  not on CI) would catch these.
- M8 — overlay one-directionality: fleet names klh-remote / fleet-enterprise in
  non-doc files: `buckle/src/gov/{federation.ts:45,hub-seam.ts:4/172/219,identity-headers.ts:6,schema.ts:67-73}`,
  `buckle/src/server.ts:78`, several gov tests, `suspenders/deploy/hub-compose.yaml:76`,
  `deploy/stack.example.yaml:37`, `hooks/lib/federation-peers.ts:3`,
  `test/hubctl-deploy.test.ts:186-203`. Mostly comments/seams (no import), but the
  law "fleet never references klh-remote" is violated in text and one test fixture.

## LOW

- L1 — `deploy/hub-deps.ts` (49 lines): untested; malformed workspace manifest
  throws mid-link; a half-linked tree is possible. Exit 0 on absent
  `node_modules/fleet/packages` is correct for the public posture but silent.
- L2 — `deploy/hub-compose.yaml:74-78` duplicated W689 comment; `fleet-deps` command
  `test -f A && exec bun A || exec bun B` can run B after A fails.
- L3 — streams-over-buffers: `belt/bin/dashboard.ts:184` `readFileSync(ROUTING_LOG)`
  whole-file read of a growing NDJSON log.
- L4 — 1500-line limit: nothing over; at risk `hooks/bin/fleet-loop.ts` (1494),
  `test/dispatch-next.test.ts` (1485), `hooks/bin/work.ts` (1437). No CI gate.
- L5 — shell-script ban: tracked shell scripts exist (four `install.sh`,
  `suspenders/scripts/load-launchd.sh`, `speedy/hooks/*.sh`,
  `speedy/skills/**/scripts/*.sh`) against "shell scripts are BANNED" (AGENTS names
  `install.sh` itself, so the ban text and the law disagree).
- L6 — `speedy/skills/brainstorming/scripts/helper.js:80` static-string innerHTML.
- L7 — CI: belt and suspenders suites run `continue-on-error`; red suites do not block.

## Clean

- No file over 1500 lines. Tracked `.env` files hold placeholders only.
- No `document.write` found. Hub-deps linker posture matrix (public = no-op) correct.
