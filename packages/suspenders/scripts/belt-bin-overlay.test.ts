// W661: closure walk + never-clobber overlay + scratch-port router smoke.
import { expect, setDefaultTimeout, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	beltBinClosure,
	flatExternals,
	flatHomeSource,
	normalizeSource,
	overlayBeltBin,
	refreshFlatHome,
	relativeImports,
	rewriteExternalSpecs,
	shimRealSource,
	smokeRouter,
	verifyFlatHome,
} from "./belt-bin-overlay.ts";

const ROOT = join(import.meta.dir, "../../belt/bin");
const ENTRY = join(ROOT, "router-shim.ts");

setDefaultTimeout(30_000);

test("relativeImports extracts static, re-export and dynamic specifiers", () => {
	expect(
		relativeImports(
			'import { a } from "./a.ts";\nexport * from "./b.ts";\nawait import("./c.ts");\nfrom "../outside.ts"',
		),
	).toEqual(["./a.ts", "./b.ts", "./c.ts"]);
});

test("closure ships the full router-shim import closure, not a hardcoded list", async () => {
	const closure = await beltBinClosure(ENTRY, ROOT);
	const names = closure.map((rel) => rel.split("/").pop());
	// the 2026-10-11 incident files the old overlay list missed
	expect(names).toContain("audio.ts");
	expect(names).toContain("escalate.ts");
	// transitive deps the old list also missed (kv-prefix via spawner.ts)
	expect(names).toContain("kv-prefix.ts");
	expect(names).toContain("memory-policy.ts");
	// router-shim's direct deps are all present
	for (const direct of [
		"admission.ts",
		"health.ts",
		"prompt-fingerprint.ts",
		"registry.ts",
		"registry-emit.ts",
		"router-condense.ts",
		"router-core.ts",
		"spawn-admission.ts",
		"spawner.ts",
	])
		expect(names).toContain(direct);
	// every closure member exists, is flat, and is code
	for (const rel of closure) {
		expect(await Bun.file(join(ROOT, rel)).exists()).toBe(true);
		expect(rel).not.toContain("..");
		expect(rel.endsWith(".ts")).toBe(true);
	}
});

test("overlay seeds an empty runtime with the full closure", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-overlay-empty-"));
	try {
		const report = await overlayBeltBin(runtime, ENTRY, ROOT);
		expect(report.copied.length).toBe(
			(await beltBinClosure(ENTRY, ROOT)).length,
		);
		for (const rel of report.copied)
			expect(await Bun.file(join(runtime, rel)).exists()).toBe(true);
		// closure ≠ wholesale: belt/bin files the router never imports stay out
		expect(report.copied).not.toContain("dashboard.ts");
		const report2 = await overlayBeltBin(runtime, ENTRY, ROOT);
		expect(report2.copied).toEqual([]);
		expect(report2.kept.length).toBe(report.copied.length);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("normalizeSource strips comments and blank lines", () => {
	expect(
		normalizeSource("// header\nconst a = 1; // trailing\n\nconst b = 2;\n"),
	).toBe("const a = 1;\nconst b = 2;");
});

test("shimRealSource maps the memory-policy shim to the real module", async () => {
	expect(await shimRealSource(ROOT, "memory-policy.ts")).toBe(
		join(import.meta.dir, "../../local-llm/memory-policy.ts"),
	);
	expect(await shimRealSource(ROOT, "health.ts")).toBeNull();
});

test("flatHomeSource resolves real modules over shims", async () => {
	expect(await flatHomeSource(ROOT, "memory-policy.ts")).toBe(
		join(import.meta.dir, "../../local-llm/memory-policy.ts"),
	);
	expect(await flatHomeSource(ROOT, "health.ts")).toBe(join(ROOT, "health.ts"));
});

test("overlay never clobbers a present runtime copy", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-overlay-kept-"));
	try {
		await writeFile(join(runtime, "registry.ts"), "// operator sentinel\n");
		const report = await overlayBeltBin(runtime, ENTRY, ROOT);
		expect(report.kept).toContain("registry.ts");
		expect(report.copied).not.toContain("dashboard.ts");
		expect(await readFile(join(runtime, "registry.ts"), "utf8")).toBe(
			"// operator sentinel\n",
		);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("refresh heals missing, diverged and shim-broken flat homes", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-refresh-heal-"));
	try {
		// the hazard state: raw shim where the flat home needs the real module
		await writeFile(
			join(runtime, "memory-policy.ts"),
			await readFile(join(ROOT, "memory-policy.ts"), "utf8"),
		);
		await writeFile(join(runtime, "registry.ts"), "// operator sentinel\n");
		const report = await refreshFlatHome(runtime, ENTRY, ROOT);
		expect(report.healed).toContain("registry.ts");
		expect(report.healed).toContain("memory-policy.ts");
		expect(await readFile(join(runtime, "memory-policy.ts"), "utf8")).toBe(
			await readFile(
				join(import.meta.dir, "../../local-llm/memory-policy.ts"),
				"utf8",
			),
		);
		// a second pass agrees everywhere — nothing left to heal
		const again = await refreshFlatHome(runtime, ENTRY, ROOT);
		expect(again.healed).toEqual([]);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("rewriteExternalSpecs flattens a back-import into belt/bin to the member sibling", () => {
	const deployDir = resolve(import.meta.dir, "../deploy");
	const externals = new Map([
		[join(deployDir, "zai-catalog.ts"), "zai-catalog.ts"],
	]);
	expect(
		rewriteExternalSpecs(
			'import { x } from "../../belt/bin/zai-catalog-rows.ts";',
			deployDir,
			externals,
			ROOT,
		),
	).toBe('import { x } from "./zai-catalog-rows.ts";');
});

test("refresh flattens a cross-package external's back-imports into belt/bin (W1047)", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-refresh-external-"));
	try {
		// seedLocalLlm rides the prefix's node_modules for the flat home's npm
		// imports (stack-config.ts → yaml) — mirror that so the closure proves.
		await symlink(
			resolve(import.meta.dir, "../../../node_modules"),
			join(runtime, "node_modules"),
		);
		const swarm = join(ROOT, "swarm.ts");
		const zai = resolve(import.meta.dir, "../deploy/zai-catalog.ts");
		expect((await flatExternals(swarm, ROOT)).has(zai)).toBe(true);
		const report = await refreshFlatHome(runtime, swarm, ROOT);
		expect(report.healed).toContain("zai-catalog.ts (external)");
		const flat = await readFile(join(runtime, "zai-catalog.ts"), "utf8");
		expect(flat).toContain('from "./zai-catalog-rows.ts"');
		expect(flat).not.toContain('from "../');
		// the seed's second leg: the router entry resolves in the SAME home
		await refreshFlatHome(runtime, ENTRY, ROOT);
		await verifyFlatHome(runtime, "swarm.ts");
		await verifyFlatHome(runtime, "router-shim.ts");
		// a second pass agrees everywhere — nothing left to heal
		const again = await refreshFlatHome(runtime, swarm, ROOT);
		expect(again.healed).toEqual([]);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("refresh fails closed while another refresh holds the lock", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-refresh-lock-"));
	try {
		await mkdir(join(runtime, ".belt-overlay.lock"));
		await expect(refreshFlatHome(runtime, ENTRY, ROOT)).rejects.toThrow();
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("verifyFlatHome rejects an unresolvable flat graph", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-verify-flat-"));
	try {
		await writeFile(join(runtime, "router-shim.ts"), 'import "./nope.ts";\n');
		await expect(verifyFlatHome(runtime)).rejects.toThrow("nope");
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("smoke proves the real router serves /health on a scratch port", async () => {
	const { port } = await smokeRouter(ROOT);
	expect(port).toBeGreaterThan(1024);
});

test("smoke fails loudly on a missing module instead of looping", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-smoke-broken-"));
	try {
		await writeFile(join(runtime, "router-shim.ts"), 'import "./nope.ts";\n');
		await expect(smokeRouter(runtime)).rejects.toThrow("nope");
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("smoke fails a shim that never serves", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-smoke-silent-"));
	try {
		await writeFile(
			join(runtime, "router-shim.ts"),
			"await new Promise(() => {});\n",
		);
		await expect(smokeRouter(runtime, { timeoutMs: 2_000 })).rejects.toThrow(
			"router smoke failed",
		);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});
