# klh fleet laws — in-repo mirror (refreshed 2026-10-15, W266.3)

Coord facts are fleet-local: a fresh install has no coord history, so the
law set ships in-repo. Each law cites its source; `tests/laws-mirror.test.ts`
verifies every citation resolves and every fleet-wide law is covered. Keep
this file in sync when a law changes — an out-of-date mirror is worse than none.

## UI engineering law

NEVER `innerHTML` / `document.write` — anywhere, ever, including migrations
of legacy chunks (they are REWRITTEN to lit-html templates, not ported).
`document.createElement` only inside web components. UI = Lit components +
CSS design tokens, native elements first (`<select>`, `<dialog>`,
`<details>` before custom). Lit is vendored (offline LAN — never CDN).
Enforced by the suspenders write-gate.

Source: AGENTS.md §UI engineering law; packages/suspenders/AGENTS.md §UI Engineering Law.

## 1500-line hard limit

Any .ts (or equivalent) past 1500 lines MUST be decomposed: split by
responsibility, DRY the second duplicate, ast-grep for shareable patterns
before adding code near the limit — one source of truth per pattern.
Enforced: the on-write gate blocks any .ts past 1500 lines.

Source: AGENTS.md §1500-line hard limit; packages/suspenders/AGENTS.md §1500-Line Hard Limit.

## Streams over buffers

Streaming interfaces by default — no whole-payload buffering unless strictly
necessary: streams for HTTP/SSE pass-through, NDJSON/line streams for logs
and feeds, bounded rings with backpressure for async writes.
`law.streams-over-buffers`.

Source: AGENTS.md §Streams over buffers; packages/suspenders/AGENTS.md §Streams Over Buffers.

## Domain separation (data-egress law)

Traffic and knowledge follow the same domain boundary, bidirectionally:
spoke-private LLM traffic NEVER transits the hub; knowledge follows
provenance (hub | private label; sessions touching both domains take the
most restrictive domain). The hub sees what transits it, nothing else —
spoke-local LLMs are invisible to the hub.

Source: external — hub/spoke federation design 2026-10-01 (not in-repo).

## dotfiles-win

klh/.dotfiles is the source of truth for machine config; machine-local
edits are drift. A config change is not done until it lands in the
dotfiles repo (dotfiles win over drift).

Source: external — owner convention 2026-10-01 (the dotfiles repo wins).

## PQC wire

Every hub↔spoke wire terminates in PQ-hybrid TLS (X25519MLKEM768, RFC 10024
— verified live on the .local planes via Caddy); a federation endpoint
served without ML-KEM hybrid is a config bug, not an option. Loopback
services run plain HTTP on 127.0.0.1 (no wire, no exposure). ML-DSA
signatures are deliberately deferred (draft-track); symmetric AES-256
unchanged.

Source: external — federation wire-crypto posture (verified 2026-10-01).

## Centralized ledger

ONE ledger: the work graph (governor.db) carries todos and work; repo docs
carry architecture and decisions only — never `- [ ]` lists. Operational
state lives in the plane, never in Markdown ledgers.

Source: packages/speedy/docs/coordination-protocol.md §Work Graph (operational state lives here — never in Markdown)

## Lane-dispatch convention

Work moves as item-scoped lane briefs: a sid per lane, work take before
code work, capsule checkpoints at every work-unit boundary, coord inbox
for interrupts, capability-aware take (refuses work its capabilities do
not cover), DONE <sha> | SPLIT | BLOCKED endings, board deep-links
#task=<id>. Between items, `coord subscribe` (W303, opened at bootstrap)
keeps your inbox PUSHED — never poll; if READY work matches your
capabilities, take it yourself.

Source: packages/suspenders/AGENTS.md §Protocol.

## Installer laws (they shape the umbrella installer)

- Spoke install baseline: installing suspenders ALWAYS installs the
  local-llm swarm — smallest models that fit (BELT_TIER=minimal = ≤4GB
  residents); every response traverses the local belt; the spoke menu is
  the hub menu plus spoke-private entries.
- Degradation: hub-unreachable ≠ down — local ladder + last-known policy
  keep working; only hub-routed rungs fail.
- Capability split: spoke machines ship NO auth/identity code — toward the
  hub they present the enrollment token as a client credential and never
  verify anyone. Signing keys are hub-only.
- Hub CR channel: change requests ride the policy pull (spoke-pulled,
  never hub-pushed).

Source: external — federation spoke-install design (2026-10-01).

## One version

`version:` in `~/.config/klh/stack.yaml` pins buckle + suspenders + belt;
hubctl renders it as the git ref every hub pulls. One monorepo, one
version, every service.

Source: AGENTS.md §One version.

## Config-over-code

Real hosts, keys, OIDC values live ONLY in machine-level runtime config
(`~/.config/klh/stack.yaml`, mode 600) — repos carry placeholders only.

Source: AGENTS.md §Config-over-code.

## Health is outside-process

A server cannot paint itself healthy. Every hub service gets a
`*-health` probe sidecar that polls the real target over the network,
degrades on consecutive misses, and re-probes before flipping to down;
compose health hits the SIDECAR, never the served process.

Source: AGENTS.md §Health is outside-process.

## Secrets are minted, never typed

Root keys are generated ON the target device (0600, idempotent, never
printed); admin + per-lane `bksk_` keys are minted via the gate's admin
API — revocable and audited.

Source: AGENTS.md §Secrets are minted, never typed.

## Scrub gate (W236)

git commit/push runs staged/unpushed ADDED lines through the scrub rule
set: `/Users/<user>` paths, local-denylist hosts/IPs/MACs, key material,
corporate-internal markers. Denies with file:line + redacted match; the
explicit `scrub:allow` marker on the offending line is the only escape.

Source: AGENTS.md §Scrub gate (W236).

## No host-path deploys

Hub containers mount git-pulled volumes — no host paths inside compose.

Source: AGENTS.md §No host-path deploys.

## qlty is THE quality tool

`.qlty/` must exist or the on-write gate silently no-ops. SPEC FIRST:
read `.qlty/qlty.toml` + the biome rule set before the first write;
never emit flagged patterns. biome owns code formatting; prettier owns
markdown only.

Source: AGENTS.md §qlty is THE quality tool; packages/suspenders/AGENTS.md §qlty Quality Doctrine.

## Shell scripts are banned

TypeScript run by Bun is the automation surface (LaunchAgent→bun entry
points and one-line aliases only). The tracked .sh set is the pinned
legacy exception, guarded by tests/law-guards.test.ts.

Source: AGENTS.md §Shell scripts are banned.

## Old repos are push-dead

All 9 original repos (suspenders, belt, buckle, local, speedy, blam + the
3 -remotes) are ARCHIVED with redirect stubs (verified 2026-10-07 via
gh). Every commit lands in THIS repo at `packages/<name>/*`.

Source: AGENTS.md §Old repos are push-dead.
