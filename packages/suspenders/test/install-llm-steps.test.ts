// test/install-llm-steps.test.ts — W771.2: native local-llm kit installer
// steps (seedLocalLlm, downloadModels, refreshSupervisor).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CONTRACT } from "../scripts/install-contract.ts";
import {
	downloadModels,
	gatewayConfigStale,
	refreshSupervisor,
	seedLocalLlm,
} from "../scripts/install-llm-steps.ts";
import type { StepContext } from "../scripts/install-run.ts";

setDefaultTimeout(120_000);

const REPO = join(import.meta.dir, ".."); // packages/suspenders
const dirs: string[] = [];
// Spawned fixtures (seed's router smoke) only bind/serve when the flat
// home lives under $HOME — homes under
// /var/folders hang the bun runtime pre-bind (observed 2026-10-15, same
// failure via the legacy belt-bin-overlay smoke CLI on an identical home).
const tmp = (label: string): string => {
	const dir = mkdtempSync(join(tmpdir(), `w7712-${label}-`));
	dirs.push(dir);
	return dir;
};
const tmpHome = (label: string): string => {
	const base = join(process.env.HOME ?? tmpdir(), ".cache", "w7712-tests");
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, label));
	dirs.push(dir);
	return dir;
};

function ctxFor(llmHome: string, repo = REPO): StepContext {
	// W778: the flat home resolves npm deps through a node_modules symlink to
	// the prefix's — a real install always has one; the fixture stubs a
	// minimal `yaml` package so verifyFlatHome's bun build resolves the kit.
	const prefix = join(llmHome, "prefix-unused");
	mkdirSync(join(prefix, "node_modules/yaml"), { recursive: true });
	writeFileSync(
		join(prefix, "node_modules/yaml/package.json"),
		JSON.stringify({ name: "yaml", version: "0.0.0-fixture" }),
	);
	writeFileSync(
		join(prefix, "node_modules/yaml/index.js"),
		'export const parse = () => ({});\nexport const stringify = () => "{}";\n',
	);
	return {
		repo,
		prefix,
		shimBin: join(llmHome, "bin-unused"),
		llmHome,
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
		wireRepo: null,
	};
}

const step = (name: string) =>
	INSTALL_CONTRACT.steps.find((s) => s.name === name);

afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("W771.2 contract flips", () => {
	test("the three kit steps are v1 real", () => {
		for (const name of [
			"seedLocalLlm",
			"downloadModels",
			"refreshSupervisor",
		]) {
			expect(step(name)?.v1).toBe("real");
		}
	});
});

describe("seedLocalLlm", () => {
	test("seeds a fresh home: belt closure, tier manifest, stubs", async () => {
		const home = tmpHome("seed-fresh");
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		for (const file of [
			"swarm.ts",
			"supervisor.ts",
			"registry.ts",
			"spawner.ts",
			"litellm-target.ts",
			"health.ts",
			"router-shim.ts",
			"memory-policy.ts",
			"belt.env",
			"routing-policy.yaml",
		]) {
			expect(existsSync(join(home, file))).toBe(true);
		}
		expect(existsSync(join(home, "tier.json"))).toBe(true);
		// W284: serve-family kit files are retired — never seeded fresh.
		for (const retired of ["gateway-supervision.ts", "serve-observation.ts"]) {
			expect(existsSync(join(home, retired))).toBe(false);
		}
	});
});

describe("seedLocalLlm never clobbers", () => {
	test("sentinel belt.env survives; belt swarm replaces a kit-serve copy", async () => {
		const home = tmpHome("seed-keep");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "belt.env"), "OPERATOR=belt\n");
		writeFileSync(
			join(home, "swarm.ts"),
			'export const swarm = "x";\ncase "serve":\n',
		);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(readFileSync(join(home, "belt.env"), "utf8")).toBe(
			"OPERATOR=belt\n",
		);
		const swarm = readFileSync(join(home, "swarm.ts"), "utf8");
		expect(swarm).toContain('from "./supervisor.ts"');
		expect(swarm).toContain('case "supervise"');
		// the serve FORK is retired — its observer import never appears
		expect(swarm).not.toContain("serve-observation");
	});
});

describe("downloadModels", () => {
	test("flag skips before any discovery", async () => {
		const res = await downloadModels({
			...ctxFor(tmp("dl-skip")),
			skipModels: true,
		});
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("--skip-models");
	});

	test("--no-llm skips seed and download entirely", async () => {
		const seedRes = await seedLocalLlm({
			...ctxFor(tmp("nl-seed")),
			noLlm: true,
		});
		expect(seedRes.status).toBe("skipped");
		const dlRes = await downloadModels({
			...ctxFor(tmp("nl-dl")),
			noLlm: true,
		});
		expect(dlRes.status).toBe("skipped");
		expect(dlRes.note).toContain("--no-llm");
	});

	test("not a fleet checkout → skipped", async () => {
		const repo = tmp("not-fleet-2");
		const res = await downloadModels(ctxFor(tmp("dl-nofleet"), repo));
		expect(res.status).toBe("skipped");
	});

	test("missing mlx-lm → skipped (forced null pythonPath)", async () => {
		const res = await downloadModels(ctxFor(tmp("dl-nopy")), {
			pythonPath: null,
		});
		expect(res.status).toBe("skipped");
		expect(res.note).toContain("mlx-lm missing");
	});

	test("forced python + models drive the injected runner (failure parity)", async () => {
		const calls: string[] = [];
		const res = await downloadModels(ctxFor(tmp("dl-run")), {
			pythonPath: "/bin/echo",
			models: ["fake/model-a", "model-b"],
			spawnDownload: async (python, model) => {
				calls.push(`${python} ${model}`);
				return model === "model-b" ? 1 : 0;
			},
		});
		expect(res.status).toBe("ok");
		expect(calls).toEqual(["/bin/echo fake/model-a", "/bin/echo model-b"]);
		expect(res.note).toContain("1 of 2");
		expect(res.detail).toBe("model-b");
	});

	test("clean downloads get the all-clear note", async () => {
		const res = await downloadModels(ctxFor(tmp("dl-clean")), {
			pythonPath: "/bin/echo",
			models: ["fake/only"],
			spawnDownload: async () => 0,
		});
		expect(res.note).toContain("downloaded 1 resident");
	});
});

describe("refreshSupervisor", () => {
	test("missing runtime fails loudly", async () => {
		const res = await refreshSupervisor(ctxFor(tmp("sv-missing")));
		expect(res.status).toBe("failed");
		expect(res.note).toContain("requires an existing belt supervisor runtime");
	});

	test("belt family on a freshly seeded home: backup, refresh, validate", async () => {
		const home = tmpHome("sv-kit");
		const seeded = await seedLocalLlm(ctxFor(home));
		expect(seeded.status).toBe("ok");
		let validated = "";
		const res = await refreshSupervisor(ctxFor(home), {
			validate: async (file: string) => {
				validated = file;
			},
		});
		expect(res.status).toBe("ok");
		expect(validated).toBe(join(home, "supervisor.ts"));
	});

	test("belt family: backup, refresh, health copy, validate target", async () => {
		const home = tmp("sv-belt");
		mkdirSync(home, { recursive: true });
		const marker = 'from "./supervisor.ts"';
		writeFileSync(
			join(home, "swarm.ts"),
			`import { run } ${marker};\nrun();\n`,
		);
		writeFileSync(join(home, "supervisor.ts"), "export const OLD = true;\n");
		writeFileSync(
			join(home, "new-supervisor.ts"),
			"export const NEW = true;\n",
		);
		writeFileSync(join(home, "new-health.ts"), "export const NEWH = 1;\n");
		let validated = "";
		const deps = {
			supervisorSource: join(home, "new-supervisor.ts"),
			healthSource: join(home, "new-health.ts"),
			validate: async (file: string) => {
				validated = file;
			},
		};
		const res = await refreshSupervisor(ctxFor(home), deps);
		expect(res.status).toBe("ok");
		expect(validated).toBe(join(home, "supervisor.ts"));
	});

	test("belt family: failed validation restores the previous code", async () => {
		const home = tmp("sv-belt-fail");
		mkdirSync(home, { recursive: true });
		const marker = 'from "./supervisor.ts"';
		writeFileSync(
			join(home, "swarm.ts"),
			`import { run } ${marker};\nrun();\n`,
		);
		writeFileSync(join(home, "supervisor.ts"), "export const OLD = true;\n");
		writeFileSync(
			join(home, "new-supervisor.ts"),
			"export const NEW = true;\n",
		);
		writeFileSync(join(home, "new-health.ts"), "export const NEWH = 1;\n");
		const deps = {
			supervisorSource: join(home, "new-supervisor.ts"),
			healthSource: join(home, "new-health.ts"),
			validate: async () => {
				throw new Error("boom");
			},
		};
		const res = await refreshSupervisor(ctxFor(home), deps);
		expect(res.status).toBe("failed");
		expect(res.note).toContain("previous code restored");
		expect(readFileSync(join(home, "supervisor.ts"), "utf8")).toBe(
			"export const OLD = true;\n",
		);
		expect(readFileSync(join(home, "health.ts"), "utf8")).toBe(
			"export const NEWH = 1;\n",
		);
	});
});

describe("W889 gateway-config regen", () => {
	test("guard: missing, stampless, or trailing-stamp yaml is stale", () => {
		const home = tmp("w889-guard");
		mkdirSync(home, { recursive: true });
		// missing yaml
		expect(gatewayConfigStale(home)).toBe(true);
		writeFileSync(join(home, "gateway-config.ts"), "export const g = 1;\n");
		const yaml = (stamp: string): string =>
			`# GENERATED by belt gateway tooling (${stamp}) — do not edit by hand.\nmodel_list: []\n`;
		// stamp trails the generator mtime
		writeFileSync(join(home, "litellm.yaml"), yaml("2020-01-01T00:00:00.000Z"));
		expect(gatewayConfigStale(home)).toBe(true);
		// fresh stamp, newer than every input mtime
		writeFileSync(
			join(home, "litellm.yaml"),
			yaml(new Date(Date.now() + 60_000).toISOString()),
		);
		expect(gatewayConfigStale(home)).toBe(false);
		// stampless hand edit counts as stale
		writeFileSync(join(home, "litellm.yaml"), "model_list: []\n");
		expect(gatewayConfigStale(home)).toBe(true);
	});

	test("canonical home: seed syncs the generator and regenerates the stale yaml", async () => {
		const root = tmpHome("w889-regen-root");
		const home = join(root, ".claude", "local-llm");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "litellm.yaml"),
			"# GENERATED by belt gateway tooling (2020-01-01T00:00:00.000Z) — do not edit by hand.\nold: yaml\n",
		);
		writeFileSync(join(home, "remotes.json"), JSON.stringify({ machines: [] }));
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(existsSync(join(home, "gateway-config.ts"))).toBe(true);
		const yamlText = readFileSync(join(home, "litellm.yaml"), "utf8");
		expect(yamlText).toContain("model_list:");
		expect(yamlText).not.toContain("old: yaml");
		expect(yamlText).not.toContain("2020-01-01");
		expect(res.note).toContain("gateway config regenerated");
	});

	test("generator failure degrades to a note; last good yaml stays", async () => {
		const root = tmpHome("w889-fail-root");
		const home = join(root, ".claude", "local-llm");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "litellm.yaml"),
			"# GENERATED by belt gateway tooling (2020-01-01T00:00:00.000Z) — do not edit by hand.\nold: yaml\n",
		);
		// no remotes.json under the fixture HOME — the generator exits 1
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(res.note).toContain("gateway config regen FAILED");
		expect(readFileSync(join(home, "litellm.yaml"), "utf8")).toContain(
			"old: yaml",
		);
	});

	test("non-canonical home: regen leg skips silently", async () => {
		const home = tmpHome("w889-noncanon");
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(res.note).not.toContain("gateway config");
	});
});
