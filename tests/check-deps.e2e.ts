// tests/check-deps.e2e.ts — W1303.1.7 co-situated proof for
// scripts/check-deps.ts: every finding kind is fabricated in a synthetic
// fleet tree (OS tmpdir — outside any checkout, so git never resolves
// upward into a worktree) and asserted through the exported checkDeps()
// plus the CLI surface (exit codes, rendered rows). The fleet tree itself
// carries known pre-existing findings at this base (yaml phantom + 5
// unpinned reach-ins from merged lanes) — proven pre-existing at c42781b4
// — so the fleet-level parity is asserted as finding-kind parity against
// the same scanner the W1249 guard test rides, not as zero.
// Shape law (empirical, matches the buckle sweep-G corpus — ./mock.ts,
// ./deps.ts): the spec file carries ONLY imports and test registrations;
// every helper lives in an imported module, because a spec file with a
// module- OR describe-scoped declaration breaks the playwright transform
// here ("Parser skipped input between top-level statements", opaque
// AggregateError build errors). Statements inside test bodies are safe.
import { expect, test } from "@playwright/test";
import { join, resolve } from "node:path";
import { checkDeps } from "../scripts/check-deps.ts";
import {
	dropFixture,
	makeFleetFixture,
	REPO_ROOT,
} from "./helpers/check-deps-fixture.ts";
import {
	edgeKey,
	kernelViolations,
	phantoms,
	reachIns,
	scanFleet,
	unusedDeclaredKlh,
} from "./helpers/fleet.import-graph.lib.ts";
import { REACH_IN_PIN } from "./helpers/fleet.import-ratchet.pin.ts";

test.describe({ tag: "@api" }, () => {
	test("clean fleet — zero findings, root resolved absolute", async () => {
		const root = makeFleetFixture(() => {});
		try {
			const r = await checkDeps(root);
			expect(r.findings).toEqual([]);
			expect(r.root).toBe(resolve(root));
		} finally {
			dropFixture(root);
		}
	});

	test("phantom: undeclared runtime import wants dependencies", async () => {
		const root = makeFleetFixture((w) => {
			w("packages/belt/src/needs.ts", `import x from "never-declared";\n`);
		});
		try {
			const r = await checkDeps(root);
			expect(r.findings).toHaveLength(1);
			expect(r.findings[0]?.kind).toBe("phantom");
			expect(r.findings[0]?.pkg).toBe("belt");
			expect(r.findings[0]?.detail).toContain("runtime → dependencies");
			expect(r.findings[0]?.detail).toContain("src/needs.ts");
		} finally {
			dropFixture(root);
		}
	});

	test("unused: declared @klh/* never imported", async () => {
		const root = makeFleetFixture((w) => {
			w(
				"packages/belt/package.json",
				JSON.stringify({
					name: "@klh/belt",
					devDependencies: { "@klh/ghost": "workspace:*" },
				}),
			);
		});
		try {
			const r = await checkDeps(root);
			expect(
				r.findings.filter((f) => f.kind === "unused").map((f) => f.detail),
			).toEqual(["belt declares @klh/ghost but never imports it"]);
		} finally {
			dropFixture(root);
		}
	});

	test("reachin: unpinned cross-package relative import is flagged; pinned class stays silent", async () => {
		const root = makeFleetFixture((w) => {
			w("packages/buckle/w.ts", `export const w = 1;\n`);
			w("packages/belt/src/r.ts", `import { w } from "../../buckle/w.ts";\n`);
		});
		try {
			const r = await checkDeps(root);
			const rows = r.findings.filter((f) => f.kind === "reachin");
			expect(rows.map((f) => f.detail)).toContain(
				"new reach-in edge belt/src/r.ts -> buckle (../../buckle/w.ts) — import package names (@klh/*), never relative reach-ins, or re-pin deliberately in the landing that adds it",
			);
			// the pinned corpus itself (suspenders -> buckle rows in REACH_IN_PIN)
			// contributes no findings for this synthetic tree
			expect(rows).toHaveLength(1);
		} finally {
			dropFixture(root);
		}
	});

	test("kernel: kernel importing fleet (either direction) is a finding", async () => {
		const root = makeFleetFixture((w) => {
			w(
				"packages/kernel/package.json",
				JSON.stringify({ name: "@klh/kernel" }),
			);
			w("packages/kernel/index.ts", `import { x } from "@klh/belt";\n`);
		});
		try {
			const r = await checkDeps(root);
			const kernels = r.findings.filter((f) => f.kind === "kernel");
			expect(kernels.map((f) => f.detail)).toContain(
				"kernel imports fleet: kernel/index.ts -> belt (@klh/belt)",
			);
		} finally {
			dropFixture(root);
		}
	});

	test("parse: a file the transpiler cannot scan is surfaced, never skipped", async () => {
		const root = makeFleetFixture((w) => {
			w("packages/belt/src/broken.ts", `export const x = {\n`);
		});
		try {
			const r = await checkDeps(root);
			expect(
				r.findings.filter((f) => f.kind === "parse").map((f) => f.detail),
			).toEqual([
				"belt/src/broken.ts does not parse — the file rides NO scan-derived check",
			]);
		} finally {
			dropFixture(root);
		}
	});

	test("package scoping: findings filter to the named package only", async () => {
		const root = makeFleetFixture((w) => {
			w(
				"packages/blam/package.json",
				JSON.stringify({ name: "@klh/blam" }),
			);
			w("packages/belt/src/needs.ts", `import x from "never-declared";\n`);
		});
		try {
			const scoped = await checkDeps(root, "blam");
			expect(scoped.packageName).toBe("blam");
			expect(scoped.findings).toEqual([]);
			const full = await checkDeps(root);
			expect(full.findings.map((f) => f.pkg)).toEqual(["belt"]);
		} finally {
			dropFixture(root);
		}
	});

	test("CLI parity: dirty tree exits 1 with rendered rows; clean scoped run exits 0", async () => {
		const root = makeFleetFixture((w) => {
			w("packages/belt/src/needs.ts", `import x from "never-declared";\n`);
		});
		try {
			const dirty = Bun.spawnSync(
				[
					process.execPath,
					join(REPO_ROOT, "scripts", "check-deps.ts"),
					"--root",
					root,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(dirty.exitCode).toBe(1);
			expect(dirty.stdout.toString()).toContain(
				"phantom\tbelt: never-declared imported but undeclared",
			);
			const clean = Bun.spawnSync(
				[
					process.execPath,
					join(REPO_ROOT, "scripts", "check-deps.ts"),
					"--root",
					root,
					"--package",
					"blam",
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			expect(clean.exitCode).toBe(0);
			expect(clean.stdout.toString()).toContain("check-deps: clean");
		} finally {
			dropFixture(root);
		}
	});

	test("fleet parity: checkDeps rows equal the guard primitives over the same scan", async () => {
		// Parity law: the CLI reports exactly what the W1249 guard's own
		// primitives report over the same scan + pin — no silent CLI/guard
		// divergence. Expected rows are DERIVED here (not hardcoded), so the
		// test survives fleet drift: a lane closing a finding moves both
		// sides together; one side silently diverging fails here.
		const fleet = await scanFleet(REPO_ROOT);
		const pinned = new Set(REACH_IN_PIN.trim().split("\n"));
		const expected = [];
		for (const entry of fleet.scans)
			for (const f of entry[1].parseFails) expected.push(`parse:${f}`);
		for (const p of phantoms(fleet))
			expected.push(`phantom:${p.pkg}:${p.name}`);
		for (const u of unusedDeclaredKlh(fleet))
			expected.push(`unused:${u.pkg}:${u.name}`);
		for (const e of reachIns(fleet))
			if (!pinned.has(edgeKey(e))) expected.push(`reachin:${edgeKey(e)}`);
		for (const e of kernelViolations(fleet))
			expected.push(`kernel:${edgeKey(e)}`);
		const r = await checkDeps(REPO_ROOT);
		expect(r.findings.length).toBe(expected.length);
		expect(
			r.findings
				.map((f) => f.kind)
				.sort()
				.join(","),
		).toBe(
			expected
				.map((s) => s.split(":")[0])
				.sort()
				.join(","),
		);
	});
});
