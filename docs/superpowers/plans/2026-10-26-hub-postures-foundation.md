# Hub Postures Foundation Implementation Plan

> For agentic workers: execute through the authoritative work graph in
> claim-bound worktrees. Use executing-plans or subagent-driven-development.
> This document is implementation guidance, not a second task ledger.

**Goal:** Establish the shared, tested configuration and resolution contract
before changing live dispatch or UI behavior.

**Architecture:** JSON documents and legacy `.prefer` inputs normalize to one
posture overlay model. A pure resolver merges ordered layers and returns unique
hub/model rules with provenance; filesystem discovery is a separate adapter.

**Tech Stack:** TypeScript on Bun, existing Zod dependency, Playwright tests,
existing qlty defaults. No dependency or lockfile changes are expected.

## Global constraints

- Spec: `docs/superpowers/specs/2026-10-26-hub-postures-design.md`.
- `JSON.parse` is the sole JSON parser; validation follows parsing.
- No new controller, route catalog, credentials, endpoints, or dispatch mode.
- No live configuration mutation, lane migration, or runtime cutover in this plan.
- Existing line-format `.prefer` behavior remains compatible.
- New TypeScript files stay below 1200 lines; never exceed 1500 lines.
- Read `.qlty/qlty.toml` and effective Biome rules before code writes.
- Work graph owns progress and dependencies; no Markdown task checkboxes.
- Commit independently verified increments with the required coauthor trailer.

## File map

Create under `packages/suspenders/hooks/lib/posture/`:

| File | Responsibility |
| --- | --- |
| `posture.zod.ts` | Full and partial schemas, derived types |
| `posture.merge.ts` | Explicit schema-aware overlay merge and provenance |
| `posture.resolve.ts` | Composition, validation and duplicate/conflict handling |
| `posture.prefer.ts` | JSON detection and parent-to-nearest layer discovery |
| `posture.policy.ts` | CAN/MUST set selection, independent of I/O |
| `posture.fixtures.ts` | Shared input factories for this module's tests |
| `posture.schema.e2e.ts` | Full/partial schema boundaries |
| `posture.resolve.e2e.ts` | Composition, inheritance and provenance |
| `posture.prefer.e2e.ts` | Filesystem precedence and legacy compatibility |
| `posture.policy.e2e.ts` | CAN/MUST and disabled-entry semantics |

Existing compatibility consumers to inspect, not silently replace:
`hooks/lib/prefer.ts`, `scripts/lib/prefer-routing.ts`.
Find the executor-chain parser by symbol search before integrating its output;
do not guess its grammar or rewrite its compatibility rules.

## Shared contract

Derive every public type from Zod schemas, rather than duplicating interfaces.
The normalized full document has the exact `version`, `hubs`, `fleets`, and
`selection` structure in the approved spec. The overlay schema makes nested
rule fields optional, but retains strict key validation and rejects nulls.

Exports to establish:

```ts
parsePostureDocument(text: string, source: string): PostureDocument;
parsePostureOverlay(text: string, source: string): PostureOverlay;
resolvePosture(base: PostureDocument, layers: PostureLayer[]): ResolvedPosture;
readPostureLayers(startDir: string): PostureLayer[];
selectPostureEntries(
  resolved: ResolvedPosture,
  usable: (entry: ResolvedEntry) => boolean,
): ResolvedEntry[];
```

`PostureLayer` contains `{source, overlay}`. `ResolvedPosture` contains the
effective `selection`, unique `entries`, and a `sources` map keyed by field
path. `ResolvedEntry` contains `{hub, model, policy, lanes}`. These are
configuration results, never evidence of live health or permission.

Errors include source and field path. Parsing malformed JSON never retries
as legacy syntax. Do not attach entire document contents to errors.

## Task 1: Define and prove full and partial schema boundaries

Consumes: approved spec only.
Produces: `posture.zod.ts` with schemas and derived public types.

1. Create fixture factories using only logical identifiers. Full fixtures
   contain MUST and CAN entries, a minimal profile, and named compositions.
2. Add tagged `@unit` tests for full documents and partial rule overlays:

```ts
test("partial overlay inherits policy rather than inventing one", {
  tag: "@unit",
}, () => {
  const parsed = parsePostureOverlay(JSON.stringify({
    version: 1,
    hubs: { example: { profiles: { minimal: {
      models: { coder: { lanes: 3 } },
    } } } },
  }), "repo/.prefer");
  expect(parsed.hubs?.example?.profiles?.minimal?.models?.coder)
    .toEqual({ lanes: 3 });
});
```

3. Run the new spec through the existing package Playwright configuration;
   first failure must name the absent module/export.
4. Implement strict schemas: policies OFF/CAN/MUST; lane counts safe
   nonnegative integers or MAX; booleans are not counts. Reject dots in
   referenced hub/profile identifiers, unknown fields, and incomplete full
   model rules. Partial overlays may inherit missing rule fields.
5. Prove rejection of negative, fractional, unsafe counts, unknown policy,
   null, malformed JSON and unsupported schema version. Include source in
   every error. Run schema tests, qlty formatting and changed-file checks.
6. Commit the schema increment, leaving runtime consumers unchanged.

## Task 2: Merge layers and resolve named compositions

Dependency: Task 1.
Consumes: schema-derived full and overlay types.
Produces: `resolvePosture`, `ResolvedPosture`, per-field sources.

1. Add regression cases before implementation:

```ts
test("nearest rule changes only its lane ceiling", { tag: "@unit" }, () => {
  const result = resolvePosture(baseFixture(), [
    layerFixture("parent/.prefer", { lanes: 2 }),
    layerFixture("repo/.prefer", { lanes: 3 }),
  ]);
  expect(result.entries).toEqual([
    { hub: "example", model: "coder", policy: "MUST", lanes: 3 },
  ]);
  expect(result.sources["hubs.example.profiles.minimal.models.coder.lanes"])
    .toBe("repo/.prefer");
});
```

2. Run and observe the missing resolver failure.
3. Implement field-aware merges, not unrestricted object merging. Only
   schema-approved own keys are merged; never assign prototype keys. Arrays
   replace, scalar fields replace, missing fields inherit.
4. Resolve after merge. Reject unknown hub/profile/fleet/posture references.
   Deduplicate identical references and identical hub/model rules. Conflicting
   hub/model rules from different profiles reject with both source references.
5. Prove OFF/0 survives inheritance, identical references do not double
   capacity, local definitions can be selected in the same overlay, and source
   tracking points to the actual winning layer.
6. Run schema and resolver tests together, qlty checks, then commit.

## Task 3: Discover .prefer overlays without breaking legacy consumers

Dependency: Task 2.
Consumes: overlay parser and resolver.
Produces: `readPostureLayers` with outermost-to-nearest ordering.

1. Add a shared filesystem fixture using the existing test fixture mechanism:
   temporary parent/repo/worktree hierarchy, cleanup, no machine HOME mutation.
2. Add tests for parent references and nearer inline overrides, walking
   across repo boundaries, no `.prefer`, unreadable `.prefer`, malformed JSON,
   and directory-walk termination.
3. Detect JSON by leading non-whitespace `{`; parse once through the shared
   parser. Keep legacy content distinguishable and normalize its supported
   directives using existing parser semantics, not a newly invented grammar.
4. Test unquoted must/prefer/can and hub directives independently from quoted
   routing expressions. Preserve reserved quoted must behavior. Preserve
   tag/color metadata; do not classify new JSON keys as unknown legacy lines.
5. Exercise existing `prefer.test.ts`, `board-prefer.test.ts`, and
   `scripts/lib/prefer-routing.test.ts` using their existing runner as well as
   the new Playwright specs. A parser integration cannot pass by testing only
   the new consumer.
6. Verify malformed JSON never restores defaults or drops restrictive parent
   settings. Run checks and commit compatibility integration.

## Task 4: Define deterministic policy-set selection

Dependency: Task 2; independent of Task 3 after the shared contract is fixed.
Consumes: `ResolvedPosture` and injected usability predicate.
Produces: `selectPostureEntries`.

1. Write tagged tests: disabled entries excluded; development override off
   uses MUST; on with usable CAN uses CAN only; on without usable CAN returns
   to MUST; no eligible entries returns an empty list for admission to explain.
2. Implement a pure selector. Do not probe networks or interpret unavailable
   audit evidence as usable. Lane ceilings remain in returned rules; the live
   admission layer, not this function, owns occupancy and reservations.
3. Prove exhaustion does not spill CAN into MUST by keeping configured
   usability distinct from instantaneous free slots in the test fixture.
4. Run all foundation specs, changed-file checks, then commit.

## Validation prerequisites and commands

The checked baseline has only `e2e/playwright.config.ts`: its test directory
is `e2e`, its match is `*.spec.ts`, and it defines no `unit` project.
It cannot run the proposed foundation specs. Before Task 1, coordinate with
the existing W1294.1 test-config owner and integrate the canonical unit
configuration. Record its exact command in this plan once verified. Do not
invent a `unit` project or add a competing test setup.

Existing compatibility checks, from the claiming worktree:

```bash
cd packages/suspenders
bun test test/prefer.test.ts test/board-prefer.test.ts scripts/lib/prefer-routing.test.ts
```

Inspect the canonical config and fixture exports before creating specs.
Foundation verification must select every new posture spec and report a
nonzero test count; an empty successful run is not acceptance.

Run qlty formatting and checks on the explicit changed-file set, then the
existing compatibility suites with their current runner. No new test tooling.
On failure, compare with the immutable claim baseline before labeling it
pre-existing. Never change unrelated tests to force a green result.

## Integration sequence after foundation

This foundation is intentionally not completion of the entire feature.
Separate dependent plans must cover:

1. Atomic shared hub/model admission, authenticated hub discovery and minting,
   dispatch/controller consumption, and removal of special Plaid branches.
2. Machine config migration with backup, dry-run effective-policy comparison,
   explicit owner placement, and shared saved selection persistence.
3. Board API plus Lit/native dropdown, effective override provenance, restart
   persistence, stale-write handling, and browser verification.
4. End-to-end staged cutover proving existing lanes drain without cancellation,
   global ceilings cannot be multiplied by project overrides, and no fallback
   escapes configured hub/model sets.

Do not delete old runtime paths before these dependent consumers are ready.
Record each dependency in the authoritative work graph before dispatch.
