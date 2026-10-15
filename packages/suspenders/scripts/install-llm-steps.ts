// scripts/install-llm-steps.ts — native local-llm kit installer steps
// (W771.2): seedLocalLlm, downloadModels and refreshSupervisor as contract
// v1 "real" steps, ported from install.sh's legacy body with parity
// semantics — seeding never clobbers the runtime home (W556: the home is
// the live fleet's source of truth), per-model download failures stay
// non-fatal (snapshot_download resumes; re-run install to fetch), and the
// supervisor refresh detects the installed family (kit serve vs advanced
// Belt) with backup + import validation + restore-on-failure.
//
// Transitional contract: install.sh's bash flags --no-llm/--skip-models
// reach these steps via the SUSPENDERS_LEGACY_NO_LLM / SUSPENDERS_LEGACY_
// SKIP_MODELS env knobs the front exports; W771.3's front-flip replaces
// the env handoff with real CLI flags.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { refreshFlatHome, smokeRouter } from "./belt-bin-overlay.ts";
import { refreshSwarm } from "./refresh-swarm.ts";
import type { StepContext, StepResult } from "./install-run.ts";

const kitDir = (ctx: StepContext): string => join(ctx.repo, "..", "local-llm");
const beltBin = (ctx: StepContext): string =>
	join(ctx.repo, "..", "belt", "bin");

const logFor = (ctx: StepContext): ((line: string) => void) => {
	const sink = ctx.json ? console.error : console.log;
	return (line: string): void => {
		sink(line);
	};
};

// ─── seedLocalLlm ───

const KIT_FILES = [
	"gateway-supervision.ts",
	"kill-listeners.ts",
	"memory-policy.ts",
	"serve-observation.ts",
	"observation.ts",
	"models.catalog.ts",
	"models.catalog.json",
];

export async function seedLocalLlm(ctx: StepContext): Promise<StepResult> {
	if (process.env.SUSPENDERS_LEGACY_NO_LLM === "1") {
		return {
			status: "skipped",
			note: "--no-llm: local-llm baseline skipped (CI/containers)",
		};
	}
	const kit = kitDir(ctx);
	if (!existsSync(join(kit, "swarm.ts"))) {
		return {
			status: "skipped",
			note: "not a fleet checkout — no local-llm kit sibling to seed from",
		};
	}
	const log = logFor(ctx);
	mkdirSync(ctx.llmHome, { recursive: true });
	for (const file of KIT_FILES) {
		const target = join(ctx.llmHome, file);
		if (!existsSync(target)) {
			copyFileSync(join(kit, file), target);
			log(`+ ${target}`);
		}
	}
	const litellmTarget = join(ctx.llmHome, "litellm-target.ts");
	if (!existsSync(litellmTarget)) {
		copyFileSync(join(beltBin(ctx), "litellm-target.ts"), litellmTarget);
		log(`+ ${litellmTarget}`);
	}
	// W741: heal the flat home's belt closure (missing AND diverged), then
	// W661: prove the flattened runtime actually serves on a scratch port.
	try {
		const report = await refreshFlatHome(
			ctx.llmHome,
			join(beltBin(ctx), "router-shim.ts"),
		);
		await smokeRouter(ctx.llmHome);
		log(
			`belt closure: ${report.healed.length} healed, ${report.kept.length} kept; router smoke ok`,
		);
	} catch (err) {
		return {
			status: "failed",
			note: `belt closure refresh or router smoke failed — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const health = join(ctx.llmHome, "health.ts");
	if (!existsSync(health)) {
		copyFileSync(join(kit, "health.ts"), health);
		log(`+ ${health}`);
	}
	// W507: the tier choice is machine config — every install re-emits the
	// manifest the swarm supervisor and llm-keepwarm read. Absent emitter or
	// a stale kit copy degrades to a note, never a failed install.
	const emitter = join(ctx.llmHome, "registry-emit.ts");
	if (existsSync(emitter)) {
		const tier = join(ctx.llmHome, "tier.json");
		const child = Bun.spawn(
			[process.execPath, emitter, "tier", "--out", tier],
			{
				env: { ...process.env, BELT_TIER: "minimal" },
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const code = await child.exited;
		if (code !== 0) {
			log("tier manifest emission skipped (stale kit registry-emit.ts)");
		}
	}
	// swarm.ts is the one kit file that MAY refresh a present copy: a
	// serve-less swarm.ts under launchd KeepAlive is exactly the busy-loop
	// flaw the serve-supervisor copy fixes (legacy parity).
	const swarm = join(ctx.llmHome, "swarm.ts");
	const swarmSource = existsSync(swarm) ? readFileSync(swarm, "utf8") : null;
	if (swarmSource === null || !swarmSource.includes('case "serve"')) {
		copyFileSync(join(kit, "swarm.ts"), swarm);
		log(`+ ${swarm} (serve supervisor)`);
	} else {
		log(`= ${swarm} kept (serve already present)`);
	}
	for (const stub of ["belt.env", "routing-policy.yaml"]) {
		const target = join(ctx.llmHome, stub);
		if (existsSync(target)) {
			log(`= ${target} kept (operator-owned runtime copy)`);
		} else {
			copyFileSync(join(kit, stub), target);
			log(`+ ${target} (stub — fill/verify at activation)`);
		}
	}
	return {
		status: "ok",
		note: `local-llm baseline seeded at ${ctx.llmHome} (never clobber; belt closure verified)`,
	};
}

// ─── downloadModels ───

export interface DownloadDeps {
	/** force the mlx-lm python path; null = treated as missing; undefined = discover */
	pythonPath?: string | null;
	/** force the model list; undefined = derive from the registry */
	models?: string[];
	/** per-model download runner; overridable for tests */
	spawnDownload?: (python: string, model: string) => Promise<number>;
}

const DOWNLOAD_SNIPPET =
	"from huggingface_hub import snapshot_download; import sys; snapshot_download(sys.argv[1])";

const mlxPython = (): string =>
	join(process.env.HOME ?? "", ".local/share/uv/tools/mlx-lm/bin/python");

async function defaultDownloadRunner(
	python: string,
	model: string,
): Promise<number> {
	const child = Bun.spawn([python, "-c", DOWNLOAD_SNIPPET, model], {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "inherit",
	});
	return await child.exited;
}

/** BELT_TIER=minimal resident set from the home registry, kit fallback. */
async function residentModels(ctx: StepContext): Promise<string[]> {
	const home = join(ctx.llmHome, "registry.ts");
	const source = existsSync(home) ? home : join(kitDir(ctx), "registry.ts");
	const prior = process.env.BELT_TIER;
	process.env.BELT_TIER = "minimal";
	try {
		const mod = (await import(source)) as {
			residentSet: () => Array<{ model: string }>;
		};
		return mod.residentSet().map((s) => s.model);
	} finally {
		if (prior === undefined) delete process.env.BELT_TIER;
		else process.env.BELT_TIER = prior;
	}
}

export async function downloadModels(
	ctx: StepContext,
	deps: DownloadDeps = {},
): Promise<StepResult> {
	if (process.env.SUSPENDERS_LEGACY_NO_LLM === "1") {
		return {
			status: "skipped",
			note: "--no-llm: model download skipped (CI/containers)",
		};
	}
	if (process.env.SUSPENDERS_LEGACY_SKIP_MODELS === "1") {
		return {
			status: "skipped",
			note: "--skip-models: skipping model download (offline install)",
		};
	}
	if (!existsSync(join(kitDir(ctx), "swarm.ts"))) {
		return {
			status: "skipped",
			note: "not a fleet checkout — no local-llm kit sibling to derive models from",
		};
	}
	const log = logFor(ctx);
	let python = deps.pythonPath !== undefined ? deps.pythonPath : mlxPython();
	if (python === null && deps.pythonPath === undefined) {
		// legacy parity: one best-effort uv install before giving up
		const uv = Bun.which("uv");
		if (uv !== null) {
			const child = Bun.spawn([uv, "tool", "install", "mlx-lm"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			await child.exited;
		}
		python = existsSync(mlxPython()) ? mlxPython() : null;
	}
	if (python === null) {
		return {
			status: "skipped",
			note: "mlx-lm missing — skipping model download (re-run install to fetch)",
		};
	}
	const models = deps.models ?? (await residentModels(ctx));
	if (models.length === 0) {
		return {
			status: "ok",
			note: "no BELT_TIER=minimal resident models to download",
		};
	}
	const run = deps.spawnDownload ?? defaultDownloadRunner;
	const failedModels: string[] = [];
	for (const model of models) {
		log(`→ downloading ${model} (resumes if partial)`);
		const code = await run(python, model);
		if (code !== 0) {
			failedModels.push(model);
			log(`  ✗ ${model} failed — re-run install to resume`);
		}
	}
	if (failedModels.length > 0) {
		return {
			status: "ok",
			note: `${failedModels.length} of ${models.length} model downloads failed (resumable)`,
			detail: failedModels.join(", "),
		};
	}
	return {
		status: "ok",
		note: `downloaded ${models.length} resident model(s) via mlx-lm`,
	};
}

// ─── refreshSupervisor ───

export interface SupervisorDeps {
	/** import validation override (tests); default spawns `bun -e await import` */
	validate?: (file: string) => Promise<void>;
	/** belt supervisor source override (tests); default belt/bin/supervisor.ts */
	supervisorSource?: string;
	/** belt health source override (tests); default belt/bin/health.ts */
	healthSource?: string;
}

async function defaultValidate(file: string): Promise<void> {
	const child = Bun.spawn(
		[process.execPath, "-e", "await import(process.argv[1])", file],
		{ stdout: "ignore", stderr: "ignore" },
	);
	const timer = setTimeout(() => child.kill(), 30_000);
	try {
		if ((await child.exited) !== 0) {
			throw new Error("supervisor import validation failed");
		}
	} finally {
		clearTimeout(timer);
	}
}

export async function refreshSupervisor(
	ctx: StepContext,
	deps: SupervisorDeps = {},
): Promise<StepResult> {
	const swarm = join(ctx.llmHome, "swarm.ts");
	if (!existsSync(swarm)) {
		return {
			status: "failed",
			note: "--refresh-supervisor requires an existing belt supervisor runtime",
		};
	}
	const swarmSource = readFileSync(swarm, "utf8");
	if (!swarmSource.includes('from "./supervisor.ts"')) {
		// kit serve family — refreshSwarm owns lock/stage/backup/rollback.
		try {
			await refreshSwarm(ctx.llmHome, undefined, false, deps.validate);
		} catch (err) {
			return {
				status: "failed",
				note: `kit serve refresh failed — ${err instanceof Error ? err.message : String(err)}`,
			};
		}
		return {
			status: "ok",
			note: "kit serve runtime refreshed (activation is a separate maintenance action)",
		};
	}
	// advanced Belt supervisor family (legacy parity: backup, refresh,
	// import-validate, restore on failure)
	const source = deps.supervisorSource ?? join(beltBin(ctx), "supervisor.ts");
	const target = join(ctx.llmHome, "supervisor.ts");
	if (!existsSync(target)) {
		return {
			status: "failed",
			note: "--refresh-supervisor requires an existing belt supervisor runtime",
		};
	}
	const backup = `${target}.before-refresh`;
	copyFileSync(target, backup);
	try {
		copyFileSync(source, target);
		copyFileSync(
			deps.healthSource ?? join(beltBin(ctx), "health.ts"),
			join(ctx.llmHome, "health.ts"),
		);
		await (deps.validate ?? defaultValidate)(target);
	} catch (err) {
		copyFileSync(backup, target);
		return {
			status: "failed",
			note: `supervisor import failed; previous code restored — ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return {
		status: "ok",
		note: "refreshed supervisor code (restart com.suspenders.local-llm to activate)",
	};
}
