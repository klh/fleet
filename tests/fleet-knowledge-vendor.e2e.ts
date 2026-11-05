// W2761 fleet-knowledge vendor guard — pins the vendored knowledge plane
// (packages/fleet-knowledge, @klh/fleet-knowledge) to its upstream shape
// and keeps the integration law that rides it:
//   1. the vendored tree's shared faces stay the ones the mission vetted —
//      every byte-identical twin the snapshot ships is still present, and
//      the one face fleet imports (knowledge-sink-client.ts) stays
//      dependency-free (no relative imports — the re-point is safe by
//      construction, and a future upstream edit that adds one fails here
//      first, not at the next install);
//   2. the retired in-tree twin does not come back — suspenders imports
//      the vendored copy through the package name, never a reach-in;
//   3. the workspace member stays a member: manifest present, dependency
//      declared in suspenders (the W649 contract, asserted here so a
//      lockfile-only rot fails the guard, not the hub).
// The snapshot is upstream-owned (github.com/klh/fleet-knowledge @
// 6c03ccf) — bytes are never edited in place; re-vendor wholesale.
// Corpus law: this tests/ config builds specs through bun --bun with no
// "type": "module" at the root — no TS-only syntax (annotations, casts,
// generics) outside strings, matching every sibling spec here.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

const ROOT = join(import.meta.dir, "..");
const VENDOR = join(ROOT, "packages", "fleet-knowledge");

// The shared faces the W2761 vetting diff proved byte-identical to the
// in-tree knowledge lib (modulo the L1 path comment) — the integration's
// compatibility contract with upstream. A file vanishing is a re-vendor
// decision, never a silent drift.
const SHARED_FACES = [
	"src/knowledge-sink-client.ts",
	"src/confidence.ts",
	"src/confidence-verdict.ts",
	"src/store-schema.ts",
	"src/prompt-policy.ts",
	"src/decant-roll.ts",
	"src/kev-review.ts",
	"src/knowledge-votes.ts",
	"src/knowledge-inference.ts",
	"src/knowledge-invalidate.ts",
	"src/knowledge-consolidate.ts",
	"src/promote-actor.ts",
];

test("vendored fleet-knowledge snapshot is intact @unit", () => {
	const manifest = JSON.parse(
		readFileSync(join(VENDOR, "package.json"), "utf8"),
	);
	expect(manifest.name, "the vendor tree must stay @klh/fleet-knowledge").toBe(
		"@klh/fleet-knowledge",
	);
	expect(manifest.exports["./src/*"]).toBe("./src/*");
	for (const face of SHARED_FACES)
		expect(
			existsSync(join(VENDOR, face)),
			`${face} missing from the vendored snapshot`,
		).toBe(true);
});

test("the fleet-imported face stays dependency-free (no relative imports) @unit", () => {
	const client = readFileSync(
		join(VENDOR, "src", "knowledge-sink-client.ts"),
		"utf8",
	);
	const relative = [...client.matchAll(/from\s+"(\.[^"]*)"/g)].map((m) => m[1]);
	expect(
		relative,
		"knowledge-sink-client.ts grew a relative import — the fleet re-point (W2761) assumes a self-contained module; re-vendor decision required",
	).toEqual([]);
});

test("suspenders imports the vendored client by package name, not a twin @unit", () => {
	expect(
		existsSync(
			join(
				ROOT,
				"packages/suspenders/hooks/lib/knowledge/knowledge-sink-client.ts",
			),
		),
		"the in-tree knowledge-sink-client twin is retired (W2761) — do not reintroduce it beside the vendored copy",
	).toBe(false);
	for (const rel of [
		"packages/suspenders/hooks/session-start.ts",
		"packages/suspenders/hooks/coord/facts.ts",
	]) {
		const src = readFileSync(join(ROOT, rel), "utf8");
		expect(
			src.includes("@klh/fleet-knowledge/src/knowledge-sink-client.ts"),
			`${rel} must import the sink client from @klh/fleet-knowledge`,
		).toBe(true);
		expect(
			src.includes("lib/knowledge/knowledge-sink-client.ts"),
			`${rel} still references the retired in-tree twin`,
		).toBe(false);
	}
	const manifest = JSON.parse(
		readFileSync(join(ROOT, "packages", "suspenders", "package.json"), "utf8"),
	);
	expect(
		manifest.dependencies["@klh/fleet-knowledge"],
		"@klh/fleet-knowledge must be a declared suspenders dependency (W649)",
	).toBeDefined();
});
