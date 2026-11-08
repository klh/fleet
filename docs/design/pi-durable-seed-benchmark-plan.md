# Pi Durable sandboxed remote agents — seed + benchmark plan (W2865)

Status: PLANNING ONLY — design/proof, no runtime activation, opt-in durable
remote execution. Owner mandate #117330/#117328 (relayed by ChatGPT
01a186a5), corrections C292 banked. Produced 2026-11-08 by lane 5d490283 as
store/installation owner.

## 0. Phase-0 findings (versions pinned today)

- Pi coding-agent install: **1.5.0** (`~/.pi/agent/install/releases/1.5.0/`,
  node_modules @earendil-works/{pi-agent-core, pi-ai, pi-codemode,
  pi-coding-agent, pi-mcp, pi-schema, pi-telemetry, pi-tui}).
- **Durable is NOT vendored in the coding-agent install** — no
  @earendil-works/pi-durable under the 1.5.0 node_modules. It is a separate
  npm package (@earendil-works/pi-durable, experimental,
  "API changes without notice"), so any executor adapter work FIRST pins an
  exact pi-durable version into a package-lock before adapter code exists.
- Extension API (coding-agent 1.5.0 types.d.ts): session_start/shutdown,
  sendUserMessage(deliverAs steer|followUp), getSessionId, ui.setStatus,
  isIdle — the W2863 receiver rides exactly this surface (landed @2f42bac1).
- Durable semantics verified from the upstream README @ 2026-11-08 (main
  branch; re-verify against the PINNED version before adapter code).

## 1. Host compatibility matrix — probed 2026-11-08 (probe, not assume)

| capability | Mac (arm64, macOS 26.6.2) | NAS (x86_64 Synology DSM) |
|---|---|---|
| container runtime | Docker Desktop 29.9.2 (VM-backed) | Docker 24.0.2 native, daemon.json absent |
| rootless/userns | n/a (VM — isolation = VM boundary) | UNPROBED — no `unshare` binary; kernel userns untested; dockerd userns-remap exists in 24.0.2 but unconfigured |
| CoW filesystem for seed clones | n/a (APFS) | **/volume1 = btrfs** ✓ (clones/snapshots native) |
| KVM /dev/kvm | none (HVf via qemu-system-aarch64 present) | **none** → Firecracker OUT on both hosts |
| cgroup hierarchy | n/a | **cgroup v1** (cgroup2fs absent) — v2-only runtimes constrained |
| microVM option | qemu + HVf | none practical (no KVM) |
| fleet store/hub reality | Mac store :7794, board :7799, spoke :4101 | compose hub (docker 24.0.2); store :7795 |

Honest boundary: the NAS userns row is UNPROBED (binary missing ≠ kernel
denied), and the NAS was intermittently unreachable this session
(no-route-to-host on first probe) — recorded UNMEASURED, never painted
healthy.

## 2. Seed manifest + promotion/rollback protocol (owner addition, C292-corrected)

Design law: the seed manifest is FLEET CONFIG — it rides the central
settings schema (`packages/settings` schema + `settings.knob-registry.ts`
adjacent registry row), never a hand-written stack.json re-creation (C292
correction 2). JSON.parse is the one parser.

Manifest (proposed shape, settings-schema typed):

    seed channel: name → { digest, runtime, tools, skills, instructions, deps, policyVersion, repoRevision }
    per-job record: { seedDigest, policyVersion, repoRevision, runtimeVersion } stamped on EVERY job

Protocol:

1. Build/test a new seed → immutable digest (content-addressed; btrfs clone
   or tar-digest).
2. **Atomically promote the channel** (single-pointer update in machine
   conf/settings; new launches resolve the digest at admission; queued jobs
   resolve at admission unless explicitly pinned).
3. Running + resumed jobs KEEP their pinned digest (checkpoint migration is
   an explicit action).
4. Rollback = channel pointer back; revoked digests denied by policy
   (separately from channel rollback).
5. **Identity injection strictly after clone**: NEW job/session/claim ids,
   scoped credentials, policy — never names/leases/keys/live tool calls in
   the clone source (C292 cleanliness law).
6. Conversation forks branch at a quiescent checkpoint via
   Durable `root.fork(entryId)` — fresh provider identity (verified §3).

## 3. Verified Pi Durable adapter semantics (pinned surface @ 2026-11-08)

Verified from the upstream README (main @ 2026-11-08); re-verify against
the exact pinned npm version in phase 0 of implementation:

- `Harness.open(storage, opts, context)` + `harness.resume()` — work
  interrupted by crash stays pending; submitting/waiting also starts the
  scheduler.
- **Idempotent submissions**: `submit({requestId})` returns the existing
  submission — the lease-fence anchor: a partitioned host cannot duplicate
  an input, Fleet holds the requestId authority.
- **Per-conversation persisted UUIDv7 provider sessionId** (`pi.provider`),
  forwarded to pi-ai as `sessionId` for prompt-cache + session affinity;
  survives reopen/retries/reset/compaction/model change; **child or fork
  receives a FRESH identity** — closes C292 corrections (1) fork≠transcript
  copy and (4) no KV/billing transfer assumed.
- `fork(entryId)` — parent entries up to entryId, parent's agent as-of-entry,
  fresh provider identity; ownership `ownerless | task`; subagent tool
  creates children inside `api.commit()` with task ownership.
- Storage: SQLite `openNodeSqliteStorage` — WAL, synchronous=NORMAL:
  commits survive process crash; **newest commits may be lost on power/host
  failure** (the honest crash-scope for overnight jobs); JSONL
  `openNodeJsonlStorage(dir, {fsync:true})` for append-only; Memory/IndexedDB
  irrelevant here.
- `ReadOnlySession` — one owner holds the database; a second process
  opens readOnly and every write/resume rejects. This IS the Durable-side
  single-owner primitive; Fleet lease fencing composes with it (Fleet lease
  record + Durable single-writer), it is NOT OS isolation (README states
  Durable is not OS isolation or Fleet authorisation).
- Abort: queued inputs withdrawn (queued writes stay), tasks aborted,
  resolves at idle — maps to Fleet steer/pause/stop at safe boundaries.

Executor adapter implications (for the phase-5 pilot design):

- Lease fencing = Fleet lease (generation-bound) + Durable single-writer
  SQLite open; a partitioned runner cannot double-open (ReadOnlySession).
- External-action idempotency keys ride `requestId`; crash after a
  non-idempotent action without receipt = uncertain outcome → reconciliation
  (per plan §5), never blind replay.
- The durable session file NEVER rides the seed (identity-bearing); it is
  per-job, created after clone + identity injection.

## 4. Benchmark specification (fair arms, honest metrics)

Law: same task, same host, matched arms; isolation-failure count is a
first-class metric; never optimise tokens at the expense of completion
quality.

Arms (all on the SAME resident base/dependency state + a separate
true-cold measurement):

1. **Cold rootless container launch** (the sensible FIRST arm per C292 —
   not the selected production runtime).
2. **Prepared filesystem seed** (btrfs clone of the seed workspace — NAS
   btrfs row is the only native CoW in the fleet today).
3. **Warm sandbox pool** (pre-warmed container, job attaches).
4. **Memory-snapshot restore** (qemu/HVf snapshot on Mac; recorded as
   feasibility arm on NAS = not practical, no KVM).

Metrics per arm (p50/p95 over N runs):

- **clone-to-ready** AND **launch-to-first-useful** (both, per C292).
- Private memory, disk delta.
- Uncached/cached/output tokens; setup calls avoided.
- Task completion quality (matched completion, human-graded gate) —
  completion quality gates every other number.
- Isolation failures (expected 0; any failure invalidates the arm).

Cleanliness: no names/leases/keys/live tool calls in any clone; measured
host compatibility (§1) gates which arms run on which host.

## 5. Sequencing and decisions needing owner input

Sequencing: phase-0 (pin pi-durable version, re-verify semantics against
the pin) → pilot host decision → benchmark execution → phase-5 pilot
design. W2863/W2866 are independent install/store faces; this plan gates
phase 5 only.

Open decisions for the owner (held as NEED_DECISION only when they block
execution; none block THIS planning item):

1. **NAS rootless tooling**: no `unshare` binary + docker 24.0.2 + cgroup
   v1 — installing rootless tooling on the NAS (and upgrading docker) is an
   owner decision; until then the NAS benchmark arms are btrfs-seed and
   warm-pool only.
2. **Pilot host**: Mac has the richer runtime menu (qemu/HVf memory
   snapshots, Docker Desktop VM); NAS has the only native btrfs. Pilot host
   choice gates the benchmark arm set.
3. **pi-durable version pin**: experimental, API-without-notice — pin
   version + re-verification is cheap but owner should bless the cadence
   (pin-on-implementation vs track-main).
