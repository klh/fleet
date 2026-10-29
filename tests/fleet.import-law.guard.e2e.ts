// W1294.8: ported 1:1 from fleet.import-law.guard.test.ts to @playwright/test (@unit).
// W1249 import-law guard (restructure proposal Phase 1, Amendment B SAFE
// NOW): kernel imports nothing in fleet; cross-package imports ride package
// names — the 112 relative reach-in edges inherited from the monorepo
// cutover are RATCHETED (no new edges; every closed edge deletes its pin
// line). Scanner + checks are pure functions over one scan — the lib lives
// in packages/suspenders/hooks/lib/import-graph.ts (W1302.4: the done-gate's
// diff-scoped ratchet shares it); tests/helpers/fleet.import-graph.lib.ts
// is its repo-root re-export. The fixture test proves the detectors have
// teeth (incl. the shebang hole that silently skipped every #!-led file).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
	edgeKey,
	edgesOfContent,
	kernelViolations,
	phantoms,
	reachIns,
	scanFleet,
	unusedDeclaredKlh,
} from "./helpers/fleet.import-graph.lib.ts";
import { REACH_IN_PIN } from "./helpers/fleet.import-ratchet.pin.ts";

const ROOT = join(import.meta.dir, "..");
let fleet = null;

test.beforeAll(async () => {
	fleet = await scanFleet(ROOT);
});

test("every package parses — no silent scan holes @unit", () => {
	const fails = [...fleet.scans]
		.flatMap(([pkg, s]) => s.parseFails.map((f) => `${pkg}/${f}`))
		.sort();
	expect(fails).toEqual([]);
});

test("no phantom dependencies (runtime ⇒ dependencies; test/content ⇒ deps or devDeps) @unit", () => {
	const rows = phantoms(fleet);
	const rendered = rows
		.map(
			(r) =>
				`${r.pkg}: ${r.name} (${r.runtime ? "runtime" : "dev"} — ${r.files.join(", ")})`,
		)
		.join("\n");
	expect(rendered, `${rows.length} phantom rows:\n${rendered}`).toBe("");
});

test("no unused declared @klh deps @unit", () => {
	expect(unusedDeclaredKlh(fleet)).toEqual([]);
});

test("kernel imports nothing in fleet @unit", () => {
	// Vacuously true until packages/kernel exists; the fixture below proves
	// the detector. When kernel lands this test starts to bite for real.
	expect(kernelViolations(fleet)).toEqual([]);
});

test("reach-in ratchet — current edges within the pinned set @unit", () => {
	const current = reachIns(fleet).map(edgeKey);
	const pinned = new Set(REACH_IN_PIN.trim().split("\n"));
	const unknown = current.filter((k) => !pinned.has(k));
	expect(
		unknown,
		`new reach-in edge(s) — fix the import (package names, never relative) or re-pin deliberately:\n${unknown.join("\n")}`,
	).toEqual([]);
});

// --- fixture: the detectors have teeth -------------------------------------

/** Synthetic fleet tree exercising every detector: kernel direction, shebang
 *  scanning, phantom position classes, reach-in, unused-declared @klh. */
function makeFixture() {
	const root = mkdtempSync(join(tmpdir(), "import-law-"));
	const w = (rel, body) => {
		const abs = join(root, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, body);
	};
	// kernel reaching into belt (relative + @klh) — the direction law
	w(
		"packages/kernel/index.ts",
		`import { x } from "../belt/src/x.ts";\nimport { y } from "@klh/belt";\n`,
	);
	w(
		"packages/belt/package.json",
		JSON.stringify({
			name: "@klh/belt",
			dependencies: { "shell-quote": "1.0.0" },
			devDependencies: {
				"@klh/unused": "workspace:*",
				"unused-pkg": "1.0.0",
				yaml: "1.0.0",
			},
		}),
	);
	// shebang runtime file (shell-quote declared) + a reach-in
	w(
		"packages/belt/src/shebang.ts",
		`#!/usr/bin/env bun\nimport { parse } from "shell-quote";\nimport { z } from "../../buckle/w.ts";\n`,
	);
	w(
		"packages/belt/src/phantom.ts",
		`import { q } from "undeclared-runtime-pkg";\n`,
	);
	w(
		"packages/belt/test/b.test.ts",
		`import { r } from "undeclared-dev-pkg";\n`,
	);
	w("packages/belt/test/unused.test.ts", `export {};\n`);
	w("packages/buckle/w.ts", `export const w = 1;\n`);
	return root;
}

test("the done-gate shares ONE scanner core (W1302.4) @unit", () => {
	// edgesOfContent (the per-file core scanPackage delegates to) must
	// classify exactly like the tree scan — the done-gate's diff ratchet
	// rides it; drift there blinds the gate to what the CI ratchet sees.
	const reach = 'import { z } from "../../buckle/w.ts";\n';
	const legal = 'import { z } from "@klh/buckle";\n';
	const pkgAbs = join(ROOT, "packages", "belt");
	const pkgsRoot = join(ROOT, "packages");
	const probe = (name, src) =>
		// pure over content — no disk write (a stray probe file under
		// packages/ would race the other test files' tree scans)
		edgesOfContent(src, "belt", name, pkgAbs, pkgsRoot);
	const reachEdges = probe("src/.w1302-probe-reach.ts", reach);
	expect(reachEdges.map((e) => e.kind)).toEqual(["reachin"]);
	expect(reachEdges.map((e) => e.targetPkg)).toEqual(["buckle"]);
	const legalEdges = probe("src/.w1302-probe-legal.ts", legal);
	expect(legalEdges.map((e) => e.kind)).toEqual(["klh"]);
});

test("scanner teeth — synthetic fleet fixture @unit", async () => {
	const root = makeFixture();
	try {
		const f = await scanFleet(root);
		const beltedges = f.scans.get("belt")?.edges ?? [];

		// shebang strip works — shell-quote seen despite `#!`
		expect(beltedges.some((e) => e.spec === "shell-quote")).toBe(true);
		// phantoms: runtime + dev, correctly positioned
		const ph = phantoms(f).filter((p) => p.pkg === "belt");
		expect(ph.map((p) => `${p.name}:${p.runtime ? "R" : "D"}`).sort()).toEqual([
			"undeclared-dev-pkg:D",
			"undeclared-runtime-pkg:R",
		]);
		// reach-in key shape
		expect(reachIns(f).map(edgeKey)).toContain(
			"belt/src/shebang.ts -> buckle (../../buckle/w.ts)",
		);
		// kernel direction: BOTH edges flagged
		const kv = kernelViolations(f).map(edgeKey);
		expect(kv.length).toBe(2);
		expect(
			kv.some((k) =>
				k.startsWith("kernel/index.ts -> belt (../belt/src/x.ts)"),
			),
		).toBe(true);
		expect(
			kv.some((k) => k.startsWith("kernel/index.ts -> belt (@klh/belt)")),
		).toBe(true);
		// declared-but-unused @klh dep
		expect(unusedDeclaredKlh(f)).toEqual([
			{ pkg: "belt", name: "@klh/unused" },
		]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
