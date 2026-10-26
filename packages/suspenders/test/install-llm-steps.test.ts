// test/install-llm-steps.test.ts — W771.2: native local-llm kit installer
// steps (seedLocalLlm, downloadModels, refreshSupervisor).
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { YAML } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALL_CONTRACT } from "../scripts/install-contract.ts";
import {
	defaultRun,
	diagnosticTail,
	downloadModels,
	ensureLiteLlmMetricsDependency,
	gatewayConfigStale,
	refreshSupervisor,
	sanitizeDiagnostic,
	seedLocalLlm,
} from "../scripts/install-llm-steps.ts";
import type { StepContext } from "../scripts/install-run.ts";
import { validateBeltWiredGuard } from "../scripts/lib/belt-wired-guard.ts";

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
	// The flat-home closure heal copies kit files that import bare `zod`
	// (stack-config.ts); bun build resolves from the runtime dir up-walk, so
	// the fixture home needs a resolvable stub (resolution only — never run).
	const zodStub = join(dir, "node_modules/zod");
	mkdirSync(zodStub, { recursive: true });
	writeFileSync(
		join(zodStub, "package.json"),
		JSON.stringify({ name: "zod", version: "0.0.0-fixture" }),
	);
	writeFileSync(join(zodStub, "index.js"), "export const z = {};\n");
	return dir;
};

const writeGuard = (home: string): void => {
	writeFileSync(join(home, "belt.env"), "BELT_WIRED_GUARD_GB=73\n", {
		mode: 0o600,
	});
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

describe("LiteLLM native metrics fresh install", () => {
	test("missing dependency installs the pinned tool and verifies the new env", async () => {
		let present = false;
		const calls: string[][] = [];
		const result = await ensureLiteLlmMetricsDependency({
			python: "/fixture/python",
			uv: "/fixture/uv",
			probe: () => (present ? null : "prometheus_client missing"),
			run: async (args) => {
				calls.push(args);
				present = true;
				return 0;
			},
		});
		expect(result).toBe("installed");
		expect(calls).toEqual([
			[
				"/fixture/uv",
				"tool",
				"install",
				"--force",
				"--python",
				"3.13",
				"--with",
				"prisma==0.15.0",
				"--with",
				"prometheus-client==0.20.0",
				"litellm[proxy]==1.103.0",
			],
		]);
	});

	test("healthy installation is left intact; failed repair remains a failure", async () => {
		let runs = 0;
		expect(
			await ensureLiteLlmMetricsDependency({
				probe: () => null,
				run: async () => {
					runs++;
					return 0;
				},
			}),
		).toBe("present");
		expect(runs).toBe(0);
		await expect(
			ensureLiteLlmMetricsDependency({
				uv: "/fixture/uv",
				probe: () => "prometheus_client missing",
				run: async () => 1,
			}),
		).rejects.toThrow("exited 1");
	});
});

describe("seedLocalLlm", () => {
	test("refuses a fresh home without a configured wired guard", async () => {
		const home = tmpHome("seed-missing-guard");
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("failed");
		expect(res.note).toContain("BELT_WIRED_GUARD_GB");
		expect(existsSync(join(home, "swarm.ts"))).toBe(false);
	});

	test("seeds a fresh prefix with the operator guard intact", async () => {
		const home = tmpHome("seed-fresh");
		writeGuard(home);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(validateBeltWiredGuard(join(home, "belt.env"))).toEqual({
			ok: true,
			value: "73",
		});
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
			"routing-policy.json",
			"repo-tier-policy.yaml",
		]) {
			expect(existsSync(join(home, file))).toBe(true);
		}
		// W1265.2.1: the tier policy seeds as machine config — 0600, general
		// default bytes, and it must parse as the W1265.2 doc shape.
		const tierPolicy = join(home, "repo-tier-policy.yaml");
		expect(statSync(tierPolicy).mode & 0o777).toBe(0o600);
		const parsed = YAML.parse(readFileSync(tierPolicy, "utf8")) as {
			version: number;
			classes: Array<{ id: string; keys: string[]; providers: string[] }>;
		};
		expect(parsed.version).toBe(1);
		expect(parsed.classes).toHaveLength(1);
		expect(parsed.classes[0].id).toBe("general");
		expect(parsed.classes[0].keys).toEqual(["*"]);
		expect(parsed.classes[0].providers).toEqual(["zai", "openrouter"]);
		expect(existsSync(join(home, "tier.json"))).toBe(true);
		// W284: serve-family kit files are retired — never seeded fresh.
		for (const retired of ["gateway-supervision.ts", "serve-observation.ts"]) {
			expect(existsSync(join(home, retired))).toBe(false);
		}
	});
});

// W1051: with ctx.json the step's log sink is console.error — the belt
// closure heal (refreshFlatHome default console.log) must ride it too, or
// file-copy lines print to stdout ahead of the JSON outcome document.
describe("seedLocalLlm --json stdout parity", () => {
	test("no file-copy lines reach stdout in --json mode", async () => {
		const home = tmpHome("seed-json-stdout");
		writeGuard(home);
		const stdoutLines: string[] = [];
		const orig = console.log;
		console.log = (line?: unknown): void => {
			stdoutLines.push(String(line));
		};
		try {
			const res = await seedLocalLlm(ctxFor(home));
			expect(res.status).toBe("ok");
		} finally {
			console.log = orig;
		}
		expect(stdoutLines).toEqual([]);
	});
});

describe("seedLocalLlm never clobbers", () => {
	test("sentinel belt.env survives; belt swarm replaces a kit-serve copy", async () => {
		const home = tmpHome("seed-keep");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "belt.env"),
			"OPERATOR=belt\nBELT_WIRED_GUARD_GB=73\n",
			{ mode: 0o600 },
		);
		writeFileSync(
			join(home, "swarm.ts"),
			'export const swarm = "x";\ncase "serve":\n',
		);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(readFileSync(join(home, "belt.env"), "utf8")).toBe(
			"OPERATOR=belt\nBELT_WIRED_GUARD_GB=73\n",
		);
		const swarm = readFileSync(join(home, "swarm.ts"), "utf8");
		expect(swarm).toContain('from "./supervisor.ts"');
		expect(swarm).toContain('case "supervise"');
		// the serve FORK is retired — its observer import never appears
		expect(swarm).not.toContain("serve-observation");
	});

	test("operator-edited repo-tier-policy survives re-install (W1265.2.1)", async () => {
		const home = tmpHome("seed-keep-tier-policy");
		mkdirSync(home, { recursive: true });
		writeGuard(home);
		const operatorDoc = "version: 1\nclasses:\n  - id: ikea\n    tier: work\n";
		writeFileSync(join(home, "repo-tier-policy.yaml"), operatorDoc, {
			mode: 0o600,
		});
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(readFileSync(join(home, "repo-tier-policy.yaml"), "utf8")).toBe(
			operatorDoc,
		);
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
		writeGuard(home);
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
		writeGuard(home);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(existsSync(join(home, "gateway-config.ts"))).toBe(true);
		const yamlText = readFileSync(join(home, "litellm.yaml"), "utf8");
		expect(yamlText).toContain("model_list:");
		const generated = Bun.YAML.parse(yamlText) as {
			litellm_settings: {
				callbacks: string[];
				require_auth_for_metrics_endpoint: boolean;
			};
		};
		expect(generated.litellm_settings.callbacks).toEqual(["prometheus"]);
		expect(generated.litellm_settings.require_auth_for_metrics_endpoint).toBe(
			true,
		);
		expect(yamlText).not.toContain("old: yaml");
		expect(yamlText).not.toContain("2020-01-01");
		expect(res.note).toContain("gateway config regenerated");
	});

	test("generator failure fails the step; bounded diagnostic retained, last good yaml stays", async () => {
		const root = tmpHome("w889-fail-root");
		const home = join(root, ".claude", "local-llm");
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(home, "litellm.yaml"),
			"# GENERATED by belt gateway tooling (2020-01-01T00:00:00.000Z) — do not edit by hand.\nold: yaml\n",
		);
		// no remotes.json under the fixture HOME — the generator exits 1
		writeGuard(home);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("failed");
		expect(res.note).toContain("gateway config regen FAILED");
		// W1205: the actual cause rides the note, sanitized of the fixture HOME
		expect(res.note).toContain("unreadable or invalid JSON");
		expect(res.note).not.toContain(root);
		expect(readFileSync(join(home, "litellm.yaml"), "utf8")).toContain(
			"old: yaml",
		);
	});

	test("non-canonical home: regen leg skips silently", async () => {
		const home = tmpHome("w889-noncanon");
		writeGuard(home);
		const res = await seedLocalLlm(ctxFor(home));
		expect(res.status).toBe("ok");
		expect(res.note).not.toContain("gateway config");
	});
});

describe("W1205 truthful regen failure diagnostics", () => {
	test("defaultRun keeps a bounded multi-line stderr tail (a81: last line was noise)", async () => {
		const dir = tmp("w1205-gen");
		const gen = join(dir, "gen.ts");
		const homePath = ["/Users", "fixuser", ".claude"].join("/");
		writeFileSync(
			gen,
			[
				`console.error(\`gateway-config: cannot read ${homePath}/remotes.json (ENOENT)\`);`,
				'console.error("gateway-config: routing-policy.yaml: bad indent at line 4");',
				'console.error("Bun v1.2.23");',
				"process.exit(1);",
			].join("\n"),
		);
		const err = await defaultRun([process.execPath, gen], dir).then(
			() => null,
			(e: Error) => e,
		);
		expect(err).toBeInstanceOf(Error);
		const msg = (err as Error).message;
		expect(msg).toContain("rc=1");
		expect(msg).toContain("ENOENT"); // cause survives the noise footer
		expect(msg).toContain("bad indent");
		expect(msg).toContain("Bun v1.2.23");
		expect(msg).not.toContain("fixuser"); // sanitized: /Users/<user> → ~
		expect(msg).toContain("~/.claude");
	});

	test("stderr tail is bounded: last 8 lines, char-capped from the front", () => {
		const lines = Array.from(
			{ length: 20 },
			(_, i) => `l${String(i + 1).padStart(2, "0")}`,
		);
		expect(diagnosticTail(lines.join("\n"))).toBe(
			"l13 | l14 | l15 | l16 | l17 | l18 | l19 | l20",
		);
		const capped = diagnosticTail("x".repeat(1000), 8, 100);
		expect(capped.startsWith("…x")).toBe(true);
		expect(capped.length).toBeLessThanOrEqual(101);
	});

	test("sanitizeDiagnostic strips ANSI, redacts, rewrites home paths", () => {
		const homePath = ["/Users", "fixuser"].join("/");
		expect(sanitizeDiagnostic(`at ${homePath}/x`)).toBe("at ~/x");
		const esc = String.fromCharCode(27);
		expect(sanitizeDiagnostic(`${esc}[31mboom${esc}[0m`)).toBe("boom");
		expect(sanitizeDiagnostic(`key sk-${"a".repeat(20)}`)).toContain(
			"[redacted]",
		);
		expect(sanitizeDiagnostic("keep // scrub:allow")).toBe(
			"keep // scrub:allow",
		);
	});

	test("runtime stderr source markers cannot expose keys or short denylisted hosts", async () => {
		const root = tmp("runtime-redaction");
		const denylist = join(root, "denylist");
		const host = ["pvt", "local"].join(".");
		const key = ["sk", "a".repeat(24)].join("-");
		const marker = ["scrub", "allow"].join(":");
		writeFileSync(denylist, host, { mode: 0o600 });
		const previous = process.env.SUSPENDERS_SCRUB_DENYLIST;
		process.env.SUSPENDERS_SCRUB_DENYLIST = denylist;
		try {
			const payload = `generator failed key=${key} host=${host} // ${marker}\n`;
			const error = await defaultRun(
				[
					process.execPath,
					"-e",
					`process.stderr.write(${JSON.stringify(payload)}); process.exit(23);`,
				],
				root,
			).then(
				() => null,
				(error: Error) => error,
			);
			expect(error).toBeInstanceOf(Error);
			expect(error?.message).toContain("rc=23");
			expect(error?.message).toContain("generator failed");
			expect(error?.message).not.toContain(key);
			expect(error?.message).not.toContain(host);
			expect(sanitizeDiagnostic(`host=${host}`)).not.toContain(host);
		} finally {
			if (previous === undefined) delete process.env.SUSPENDERS_SCRUB_DENYLIST;
			else process.env.SUSPENDERS_SCRUB_DENYLIST = previous;
		}
	});

	test("W1205.2: a stdout-flooding generator cannot deadlock defaultRun", async () => {
		const dir = tmp("w12052-flood");
		const gen = join(dir, "flood.ts");
		writeFileSync(
			gen,
			[
				`await Bun.write(Bun.stdout, "y".repeat(${8 * 1024 * 1024}));`,
				"process.exit(0);",
			].join("\n"),
		);
		// undrained, the 8MB stdout fills the pipe and the generator blocks
		// until the 120s spawn timeout — draining resolves immediately.
		await defaultRun([process.execPath, gen], dir);
	});

	test("W1205.2: stdout flood keeps the stderr cause and exit status", async () => {
		const dir = tmp("w12052-flood-cause");
		const gen = join(dir, "flood-cause.ts");
		writeFileSync(
			gen,
			[
				`await Bun.write(Bun.stdout, "y".repeat(${8 * 1024 * 1024}));`,
				'console.error("gateway-config: bad indent at line 4");',
				"process.exit(7);",
			].join("\n"),
		);
		const error = await defaultRun([process.execPath, gen], dir).then(
			() => null,
			(e: Error) => e,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error?.message).toContain("rc=7");
		expect(error?.message).toContain("bad indent at line 4");
	});

	test("W1205.2: oversized stderr stays bounded in memory and message", async () => {
		const dir = tmp("w12052-oversize");
		const gen = join(dir, "oversize.ts");
		const lines = Array.from(
			{ length: 300 },
			(_, i) => `l${String(i).padStart(3, "0")}${"x".repeat(76)}`,
		);
		writeFileSync(
			gen,
			[
				`await Bun.write(Bun.stderr, ${JSON.stringify(lines.join("\n"))});`,
				"process.exit(9);",
			].join("\n"),
		);
		const error = await defaultRun([process.execPath, gen], dir).then(
			() => null,
			(e: Error) => e,
		);
		const msg = (error as Error).message;
		expect(msg).toContain("rc=9");
		expect(msg).toContain("B truncated]");
		expect(msg.length).toBeLessThan(900);
		expect(msg).toContain("l299"); // the true tail survives
		expect(msg).not.toContain("l000"); // the flooded front is gone
	});
});
