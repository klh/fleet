// test/install-llm-steps.test.ts — W771.2: native local-llm kit installer
// steps (seedLocalLlm, downloadModels, refreshSupervisor).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CONTRACT } from "../scripts/install-contract.ts";
import {
	downloadModels,
	refreshSupervisor,
	seedLocalLlm,
} from "../scripts/install-llm-steps.ts";
import type { StepContext } from "../scripts/install-run.ts";

setDefaultTimeout(120_000);

const REPO = join(import.meta.dir, ".."); // packages/suspenders
const dirs: string[] = [];
// Spawned fixtures (seed's router smoke, refreshSwarm's import validation)
// only bind/serve when the flat home lives under $HOME — homes under
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
	return {
		repo,
		prefix: join(llmHome, "prefix-unused"),
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

const ENV_KEYS = [
	"SUSPENDERS_LEGACY_NO_LLM",
	"SUSPENDERS_LEGACY_SKIP_MODELS",
] as const;
const savedEnv = ENV_KEYS.map((k) => process.env[k]);
afterAll(() => {
	for (const [i, key] of ENV_KEYS.entries()) {
		if (savedEnv[i] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[i];
	}
});
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
	test("seeds a fresh home: kit files, closure heal, tier manifest, stubs", async () => {
		const home = tmpHome("seed-fresh");
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		for (const file of [
			"gateway-supervision.ts",
			"memory-policy.ts",
			"serve-observation.ts",
			"observation.ts",
			"models.catalog.ts",
			"models.catalog.json",
			"litellm-target.ts",
			"health.ts",
			"swarm.ts",
			"router-shim.ts",
			"registry-emit.ts",
			"belt.env",
			"routing-policy.yaml",
		]) {
			expect(existsSync(join(home, file))).toBe(true);
		}
		expect(existsSync(join(home, "tier.json"))).toBe(true);
	});
});

describe("seedLocalLlm never clobbers", () => {
	test("sentinel belt.env and serve-swarm survive the seed", async () => {
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
		expect(readFileSync(join(home, "swarm.ts"), "utf8")).toBe(
			'export const swarm = "x";\ncase "serve":\n',
		);
	});
});

describe("downloadModels", () => {
	test("env knobs skip before any discovery", async () => {
		process.env.SUSPENDERS_LEGACY_SKIP_MODELS = "1";
		try {
			const res = await downloadModels(ctxFor(tmp("dl-skip")));
			expect(res.status).toBe("skipped");
			expect(res.note).toContain("--skip-models");
		} finally {
			delete process.env.SUSPENDERS_LEGACY_SKIP_MODELS;
		}
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

	test("kit serve family routes to refreshSwarm (no-op on a seeded home)", async () => {
		const home = tmpHome("sv-kit");
		const seeded = await seedLocalLlm(ctxFor(home));
		expect(seeded.status).toBe("ok");
		const res = await refreshSupervisor(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(res.note).toContain("kit serve runtime refreshed");
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
