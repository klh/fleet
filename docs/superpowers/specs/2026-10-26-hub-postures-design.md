# Composable hub postures and .prefer overrides

Status: architecture approved by owner; written specification awaiting review.
Work: W1315. Owner decisions: Copilot session 1a536a25, 2026-10-26.

## Goal

Replace the separate Plaid route catalog and special dispatch mode with one
scheduler driven by named, composable configurations. `plaid`, `minimal`, and
other names are ordinary user-defined profiles, not code branches.

Keep existing Buckle authentication, entitlement, health, admission, controller
authority, and dispatch holds. A posture controls placement and capacity; it
does not grant access or create another controller.

## Configuration

Use one versioned JSON schema and resolver for machine configuration, reusable
project/template definitions, and JSON-format `.prefer` files. Parse JSON with
`JSON.parse`, then validate. Machine configuration owns actual hub endpoints
and credentials; reusable files contain logical hub/model names only.

Proposed configuration shape (illustrative logical names, not live settings):

```json
{
  "version": 1,
  "hubs": {
    "example-hub": {
      "profiles": {
        "plaid": {
          "models": {
            "example-model": { "policy": "MUST", "lanes": "MAX" },
            "development-model": { "policy": "CAN", "lanes": 2 }
          }
        },
        "minimal": {
          "models": {
            "example-model": { "policy": "MUST", "lanes": 1 }
          }
        }
      }
    }
  },
  "fleets": {
    "fleet": {
      "postures": {
        "plaid": ["example-hub.plaid"],
        "minimal": ["example-hub.minimal"]
      }
    }
  },
  "selection": {
    "fleet": "fleet",
    "posture": "plaid",
    "developmentOverride": false
  }
}
```

Hub profile references are parsed against known identifiers, not guessed from
endpoints. Identifiers used in dotted references cannot contain dots. A fleet
posture references hub profiles only; recursive fleet compositions are outside
this design.

Policy and capacity are independent:

| Field | Meaning |
| --- | --- |
| `policy: MUST` | Normal eligible placement set |
| `policy: CAN` | Explicit development override set, not automatic overflow |
| `policy: OFF` | Disabled |
| `lanes: 0` | Disabled regardless of policy |
| `lanes: N` | Nonnegative integer concurrent-lane ceiling, not minimum |
| `lanes: MAX` | No configured lane ceiling; measured safe capacity still bounds launches |

An explicitly enabled, usable CAN set replaces MUST placement. If no CAN
entry is usable, use MUST. Exhausting CAN capacity does not silently spill
into MUST while CAN remains the active override. With no eligible capacity,
report the blocked reason; never use an unlisted hub/model.

## .prefer precedence and compatibility

Convenient local overrides take precedence over the selected central posture.
Support both named references and partial inline definitions using the same
schema. Example repo-local JSON `.prefer`:

```json
{
  "version": 1,
  "selection": {
    "fleet": "fleet",
    "posture": "minimal"
  },
  "hubs": {
    "example-hub": {
      "profiles": {
        "minimal": {
          "models": {
            "example-model": { "lanes": 3 }
          }
        }
      }
    }
  }
}
```

Resolution order is central definitions and saved selection, followed by
outermost parent `.prefer` through nearest `.prefer` for the working path.
Walk across repository boundaries. A nearer file overrides only specified
fields; absent fields inherit, OFF/0 explicitly disables, and arrays replace
rather than concatenate. Merge before reference validation so a local file
can define and select its own profile.

Preserve existing line-format `.prefer` behavior, including its executor-chain
and quoted routing planes, tag/color metadata, and supported hub directives.
Detect JSON object format without reinterpreting legacy lines. Both formats
feed the same resolved-policy boundary; do not maintain an independent legacy
scheduler. A malformed JSON file is an error, not a reason to try legacy
parsing or restore default routes.

Legacy compatibility must not silently promote a historically reserved quoted
`must` routing expression into enforced authorization. Existing restrictions
and explicit overrides retain their documented meanings.

## Composition, accounting, and resolution

Resolve profiles to unique `(hub, model)` entries. Repeating a reference never
adds its capacity again. Distinct referenced profiles defining conflicting
rules for the same entry are invalid; require one explicit effective rule
rather than relying on list order or summing limits.

One pure resolver returns effective selection, eligible entries, policy and
lane ceilings, and field-level source provenance. A separate admission step
combines that result with live quota, health, capacity, and current claims.
CLI, dispatch, controller, and UI all consume these shared contracts.

Model ceilings apply to the hub/model pool, not separately per project:
multiple projects cannot multiply shared physical capacity. Local overrides
may further restrict or explicitly change configuration, but never bypass
the hub's operational admission limits. Count existing running lanes against
the relevant ceiling.

## Suspenders and persistence

Expose named fleet postures in a native dropdown. Persist the selected base
posture in machine-level configuration using existing atomic 0600 writes.
The remembered selection is shared controller state, not browser-only storage.

Display both the selected base and the effective posture for the selected
project, including `.prefer` overrides and their source paths. Show disabled
entries, ceilings, active development override, and blocked reasons. Selecting
a base posture must not overwrite a repository's `.prefer` file.

Changes affect new launches. Existing lanes are not killed or restarted when
a profile disables them or lowers a ceiling; they drain naturally, and new
launches wait while occupancy exceeds the effective limit.

## Errors and migration

Reject unknown references, invalid policies/counts, conflicting composition,
and malformed configuration with source-qualified diagnostics. Never silently
fall back to a hardcoded ZAI/Copilot route list.

Inventory current machine configuration and legacy consumers before cutover.
Translate current explicit settings into named profiles once, preserving the
effective placement and ceilings; retain a recoverable original. Do not infer
owner preferences from whichever route happened to be available.

Replace route-name selection with hub/model/profile selection throughout
dispatch and UI. Remove the Plaid route catalog and obsolete special-mode
branches once the unified path is verified. Preserve existing active claims,
keys, transcripts, and completion evidence.

## Acceptance

- One schema and resolver serve CLI, scheduler, controller, and UI.
- Named compositions, duplicate handling, conflicts, and pool accounting
  have deterministic tests.
- Parent/repo/worktree overrides, references plus inline rules, inherited
  fields, array replacement, OFF/0, malformed JSON, and legacy format are covered.
- CAN replacement and return to MUST are covered without unlisted fallback.
- Concurrent admission respects shared hub/model ceilings and existing holds.
- The dropdown survives server/browser restart and truthfully displays
  effective local overrides.
- A posture switch does not cancel live lanes or bypass Buckle checks.
- Migration proves before/after effective-policy parity on explicit fixtures.
- Existing checks and appropriate Playwright coverage pass before rollout.

## Delivery boundaries

After written-spec approval, plan schema/resolver, dispatch migration,
configuration migration, and UI integration as bounded scopes. Establish the
shared contract first; parallelize independent consumers only after that
contract is fixed. This specification does not authorize changes to unrelated
PaaS compliance lanes or account entitlements.
