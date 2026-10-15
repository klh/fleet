# Policy-tier architecture — W775 (2026-10-15)

Status: adopted after 3 Opus-coordinated review rounds (2026-10-14/15).
This record is the plan the W775 children implement against: W775.1
(enterprise GUI area), W775.2 (platform features per policy tier).
Companion records: `docs/enterprise-packaging-v0.md` (SKUs/gate map),
`docs/enterprise-gap-review-w688-2026-10-12.md` (overlay wiring state).

## The tier law — bypassability picks the tier

One question classifies any policy: **can a malicious agent bypass it?**

- **No** → the policy may live in prompt tier — the agent's own context
  (strategy, style, priorities). It shapes behavior because the agent
  carries it, not because something blocks it.
- **Yes** → it must live at gate tier (an enforced check on an
  irreversible act) or structural tier (the constraint IS the
  architecture — the bypass route does not exist).

| tier       | test                              | fleet exemplars                              |
| ---------- | --------------------------------- | -------------------------------------------- |
| structural | identity / resource / state bound | health is outside-process (probe sidecars)   |
| gate       | irreversible act                  | scrub, content gate, done-gate               |
| prompt     | behavior / strategy               | voice, priorities, work preferences          |

Prompt-tier policies that matter get **gate-tier anti-skip**: they are
rendered into the lane's brief by the compiler and the fence refuses a
brief that does not carry the current signature (land 3). The agent
cannot skip what it never received, and the lane cannot launch without
the receipt.

## Enterprise = pack + overlays + keys, never a base fork

The enterprise tier is composed at deploy time: per-tenant **policy
packs** (data), the **klh-remote overlays** (code, `klh/fleet-enterprise`
checkout), and **minted keys** (secrets). No base-repo fork; the public
stack keeps honest 501 seams and defensive primitives (W233 rule,
enterprise-packaging-v0).

## Land 1 — identity bridge (Entra → fleet primitives)

`EntraIdentityAdapter` lives in the enterprise checkout
(`klh/fleet-enterprise`, `packages/buckle-remote/src/gov/`). The Entra
app/service principal is the hubctl operator identity; group membership
is the only human-to-permission mapping:

| Entra group  | fleet primitive                                              |
| ------------ | ------------------------------------------------------------ |
| admins       | approval gates — the humans who answer NEED_DECISION and sign done-gates |
| lane-members | `bksk_` key scopes via the buckle admin API (`POST /v1/admin/keys`, scope `buckle:proxy:WRITE_`) |
| read-only    | board + audit read surfaces (board API reads, W231 hub console) |

Membership changes re-scope/rotate affected `bksk_` keys — a demoted
member's lane key dies at next rotation, not at next renewal. The
config half is already wired: `stack.yaml` `auth.oidc` (issuer,
audience, scope placeholders in `deploy/stack.example.yaml:73`, W191
enforcement is base code, Entra tenant values only in the real
machine-level `stack.yaml`). The adapter finishes the **lane-key
mapping**: OIDC principal → group set → key scope set, evaluated at
enrollment and on the rotation pass.

## Land 2 — structural hook at the launch fence

Per-tenant policy **version + hash** is enforced at the LAUNCH FENCE —
`packages/suspenders/scripts/lib/launch-fencing.ts` (W572 durable
launch intents: `reserveLaunchIntent` → `registerLaunch` →
`fencedExecutor`), consumed by `supervise.ts`; the durable lane
registry's `registry prune` verb in `dispatch-next.ts` reaps lanes whose
tenant pack went stale. NOT spawn-admission: admission is memory-only
and a restarted supervisor would forget it. The fence is durable — a
lane cannot launch (or resume) unless its tenant policy pack is current.

hubctl mounts packs per tenant (pack PATH in the hub profile, like
every other runtime knob; content stays machine-local). Decision
shape (`can agent X access vault Y`) is a Rego candidate evaluated at
the fence; runtime config itself stays `stack.yaml` — the pack carries
policy, not hosts or keys.

## Land 3 — signed policy compiler

Per-tenant policy pack: YAML, versioned and locked like
`packages/suspenders/skills-lock.json` (content hash + version row per
tenant). At the suspenders brief compiler — `composeBrief`
(`scripts/lib/brief.ts:156`) — the pack renders into every dispatch
brief and AGENTS.md BEFORE serialization. The activation fence is the
pre-spawn verification pass (`scripts/lib/brief-verify.ts`, W223.2:
structure/size/control-chars before spawn): it gains a policy check —
the brief hash must carry the current policy-pack signature, mismatch
REFUSES the lane. Copilot briefs already hard-refuse on verify failure;
the policy check is hard for every harness — that is the gate-tier
anti-skip for everything the pack carries.

## Review corrections carried (hallucination guards)

- fleet-loop has no `runTemplate` — the launch fence is the real seam.
- The structural hook is the launch fence, NOT spawn-admission
  (memory-only; the fence is durable across supervisor restarts).
- "approval-fence" / "board-executor" are not real primitive names —
  groups map onto the actual fences: activation fence, approval gates
  (NEED_DECISION + done-gate approvers), done-gate.
