# klh fleet laws — in-repo mirror (2026-10-02)

Coord facts are fleet-local: a fresh install has no coord history, so the
law set ships in-repo. Each law cites its source. Keep this file in sync
when a law changes — an out-of-date mirror is worse than none.

## UI: never innerHTML

NEVER `innerHTML` / `document.write` — anywhere, ever, including migrations
of legacy chunks (they are REWRITTEN to lit-html templates, not ported).
`document.createElement` only inside web components. UI = Lit components +
CSS design tokens, native elements first (`<select>`, `<dialog>`,
`<details>` before custom). Lit is vendored (offline LAN — never CDN).
Enforced by the suspenders write-gate.

Source: suspenders CLAUDE.md §UI Engineering Law.

## 1500-line hard limit

Any .ts (or equivalent) past 1500 lines MUST be decomposed: split by
responsibility, DRY the second duplicate, ast-grep for shareable patterns
before adding code near the limit — one source of truth per pattern.
Enforced: the on-write gate blocks any .ts past 1500 lines.

Source: suspenders CLAUDE.md §1500-Line Hard Limit.

## Streams over buffers

Streaming interfaces by default — no whole-payload buffering unless strictly
necessary: streams for HTTP/SSE pass-through, NDJSON/line streams for logs
and feeds, bounded rings with backpressure for async writes.
`law.streams-over-buffers`.

Source: suspenders CLAUDE.md §Streams Over Buffers.

## Domain separation (data-egress law)

Traffic and knowledge follow the same domain boundary, bidirectionally:
spoke-private LLM traffic NEVER transits the hub; knowledge follows
provenance (hub | private label; sessions touching both domains take the
most restrictive domain). The hub sees what transits it, nothing else —
spoke-local LLMs are invisible to the hub.

Source: suspenders docs/design/buckle/federation design doc (2026-10-01).

## dotfiles-win

klh/.dotfiles is the source of truth for machine config; machine-local
edits are drift. A config change is not done until it lands in the
dotfiles repo (dotfiles win over drift).

Source: owner convention (2026-10-01), klh/.dotfiles.

## PQC wire

Every hub↔spoke wire terminates in PQ-hybrid TLS (X25519MLKEM768, RFC 10024
— verified live on the .local planes via Caddy); a federation endpoint
served without ML-KEM hybrid is a config bug, not an option. Loopback
services run plain HTTP on 127.0.0.1 (no wire, no exposure). ML-DSA
signatures are deliberately deferred (draft-track); symmetric AES-256
unchanged.

Source: federation doc §Wire crypto posture (verified 2026-10-01).

## Centralized ledger

ONE ledger: the work graph (governor.db) carries todos and work; repo docs
carry architecture and decisions only — never `- [ ]` lists. Operational
state lives in the plane, never in Markdown ledgers.

Source: suspenders docs/coordination-protocol.md + CLAUDE.md multi-agent
law.

## Lane-dispatch convention

Work moves as item-scoped lane briefs: a sid per lane, work take before
code work, capsule checkpoints at every work-unit boundary, coord inbox
for interrupts, capability-aware take (refuses work its capabilities do
not cover), DONE <sha> | SPLIT | BLOCKED endings, board deep-links
#task=<id>. Between items, `coord subscribe` (W303, opened at bootstrap)
keeps your inbox PUSHED — never poll; if READY work matches your
capabilities, take it yourself.

Source: AGENTS.md lane protocol + suspenders coordination-protocol doc.

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

Source: federation doc §Spoke install baseline, §Degradation law,
§Capability split, §Hub change-request channel.
