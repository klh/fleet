// knowledge-cli-help@unit.e2e.ts — the knowledge CLIs' per-verb help (W651):
// every verb declares on the verb-kit with a description, the registry
// listing renders one line per verb, and both faces (the standalone bin and
// coord's nested dispatch) answer --help with generated text. Spec-shape
// law: no TS annotations here.
import { expect, test } from "@playwright/test";
import { join } from "node:path";
import {
	DISTILL_VERBS,
	GRAPH_VERBS,
	dispatchSub,
} from "../hooks/lib/knowledge/distill/cli.ts";
import { renderRegistryHelp, renderVerbHelp } from "../hooks/lib/verb-kit.ts";

const RUN = DISTILL_VERBS.find((v) => v.name === "run");
const ABOUT = GRAPH_VERBS.find((v) => v.name === "about");

test("the distill + graph specs carry a help line and per-verb help renders it", () => {
	expect(RUN).toBeDefined();
	expect(ABOUT).toBeDefined();
	const runHelp = renderVerbHelp(RUN);
	expect(runHelp).toContain("usage: knowledge-distill run");
	expect(runHelp).toContain("one distiller pass");
	expect(runHelp).toContain("flags: --job --once --force --json");
	const aboutHelp = renderVerbHelp(ABOUT);
	expect(aboutHelp).toContain("usage: knowledge-graph about");
	expect(aboutHelp).toContain("which knowledge entries touch a target");
});

test("the registry listing renders one description line per verb", () => {
	const reg = renderRegistryHelp(
		"knowledge-distill",
		"idle distiller:",
		DISTILL_VERBS,
	);
	for (const v of DISTILL_VERBS) expect(reg).toContain(`  ${v.name} — `);
	const graph = renderRegistryHelp(
		"knowledge-graph",
		"knowledge graph:",
		GRAPH_VERBS,
	);
	for (const v of GRAPH_VERBS) expect(graph).toContain(`  ${v.name} — `);
});

test("dispatchSub answers a sub-verb --help with the verb's help (exit 0)", async () => {
	const logs = [];
	const orig = console.log;
	console.log = (m) => logs.push(String(m));
	try {
		const code = await dispatchSub(
			"knowledge-distill",
			"idle:",
			DISTILL_VERBS,
			["run", "--help"],
		);
		expect(code).toBe(0);
	} finally {
		console.log = orig;
	}
	expect(logs.join("\n")).toContain("usage: knowledge-distill run");
	expect(logs.join("\n")).toContain("one distiller pass");
});

test("bare dispatchSub renders the generated registry listing (exit 2)", async () => {
	const logs = [];
	const orig = console.log;
	console.log = (m) => logs.push(String(m));
	try {
		const code = await dispatchSub(
			"knowledge-graph",
			"graph:",
			GRAPH_VERBS,
			[],
		);
		expect(code).toBe(2);
	} finally {
		console.log = orig;
	}
	expect(logs.join("\n")).toContain(
		"about | neighbours | path | contradictions",
	);
	expect(logs.join("\n")).toContain("  about — which knowledge entries");
});

test("the standalone bin answers per-verb and registry --help (exit 0)", () => {
	const bin = join(
		import.meta.dir,
		"..",
		"hooks",
		"bin",
		"knowledge-distill.ts",
	);
	const run = Bun.spawnSync(["bun", bin, "run", "--help"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(run.exitCode).toBe(0);
	expect(run.stdout.toString()).toContain("usage: knowledge-distill run");
	expect(run.stdout.toString()).toContain("one distiller pass");
	const all = Bun.spawnSync(["bun", bin, "--help"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(all.exitCode).toBe(0);
	expect(all.stdout.toString()).toContain(
		"status | run | pause | resume | watch",
	);
	expect(all.stdout.toString()).toContain(
		"  watch — the long-running hub loop",
	);
});
