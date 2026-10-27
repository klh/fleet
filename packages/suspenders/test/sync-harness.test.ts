import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	executePlan,
	type StepContext,
} from "../scripts/install/install-run.ts";
import {
	coldCacheVerdict,
	materializeDependencies,
	materializeProduction,
	offlineResolveArgs,
	productionFetchArgs,
	productionInstallArgs,
	syncHarness,
} from "../scripts/sync-harness.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(problem?: "syntax" | "import" | "execution") {
	const root = mkdtempSync(join(tmpdir(), "fleet-sync-harness-"));
	roots.push(root);
	const source = join(root, "source");
	mkdirSync(source);
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", source, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		return result.stdout.toString().trim();
	};
	const put = (relative: string, value: string) => {
		const file = join(source, relative);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, value);
	};
	// scoped names match the real payload packages (@klh/*) — the private-name
	// derivation (W1281.9) keys on the manifest names as shipped.
	for (const [dir, name] of [
		["suspenders", "@klh/suspenders"],
		["belt", "belt"],
		["local-llm", "local-llm"],
		["blam", "@klh/blam"],
		["buckle", "@klh/buckle"],
		["telemetry", "@klh/telemetry"],
	] as const)
		put(
			`packages/${dir}/package.json`,
			JSON.stringify({
				name,
				version: "1.0.0",
				type: "module",
				dependencies: dir === "suspenders" ? { blam: "workspace:*" } : {},
			}),
		);
	for (const name of [
		"bin",
		"lib",
		"board-html",
		"coord",
		"board",
		"gates",
		"launchd",
		"rules",
	])
		put(
			`packages/suspenders/hooks/${name}/fixture.ts`,
			"export const value = 1;",
		);
	put("packages/suspenders/agent-rules/fixture.ts", "export const value = 1;");
	for (const file of [
		"gate.ts",
		"session-start.ts",
		"subagent-start.ts",
		"session-end.ts",
		"pre-compact.ts",
		"statusline.ts",
		"subagent-statusline.ts",
		"bin/coord.ts",
		"bin/work.ts",
		"bin/oracle.ts",
		"bin/fleet-loop.ts",
		"bin/fleet-tracker.ts",
		"bin/fleet-watch.ts",
		"bin/fleet-board.ts",
		"bin/morph.ts",
		"bin/llm-keepwarm.ts",
		"bin/fallback-drill.ts",
		"bin/soak.ts",
		"bin/review-reconcile.ts",
		"lib/morph.ts",
		"board/prompt-transform.ts",
	])
		put(`packages/suspenders/hooks/${file}`, "export const value = 1;");
	for (const file of ["dispatch-next.ts", "supervise.ts"])
		put(`packages/suspenders/scripts/${file}`, "export const value = 1;");
	put("packages/telemetry/src/http-trace.ts", "export const trace = 1;");
	put(
		"packages/buckle/src/server.ts",
		'export { trace } from "../../telemetry/src/http-trace.ts";',
	);
	put("packages/buckle/routing-policy.json", "{}");
	put("packages/buckle/repo-policy.json", "{}");
	put("packages/suspenders/hooks/knowledgeworker.md", "fixture");
	put("packages/suspenders/deploy/services.yaml", "services: []");
	put(
		".githooks/pre-commit",
		'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook commit\n',
	);
	put(
		".githooks/pre-push",
		'#!/bin/sh\nexec bun "$P/hooks/bin/scrub-gate.ts" hook push\n',
	);
	put(
		"packages/suspenders/scripts/lib/shared.ts",
		problem === "syntax" ? "export const =;" : "export const value = 1;",
	);
	put(
		"packages/suspenders/hooks/bin/work.ts",
		problem === "import"
			? 'import "./missing.ts";'
			: 'export { value } from "../../scripts/lib/shared.ts";',
	);
	if (problem === "execution")
		put(
			"packages/suspenders/hooks/board/prompt-transform.ts",
			'throw new Error("bad runtime import");',
		);
	// W1256.1/W1466: the payload faces (sync-harness CLOSURE_ENTRIES) must
	// exist — fake faces, same paths as the real payload — and the ship list
	// is their computed closure: the edges below reach local-llm, the buckle
	// gate defaults, blam src and agent-rules the way the real graph does.
	for (const file of ["router-shim.ts", "supervisor.ts", "dashboard.ts"])
		put(`packages/belt/bin/${file}`, "export const value = 1;");
	put(
		"packages/belt/bin/fixture.ts",
		'export { value } from "../../local-llm/fixture.ts";',
	);
	put(
		"packages/buckle/src/policy.ts",
		[
			'export const upstreams = new URL("../upstreams.json", import.meta.url);',
			'export const routing = new URL("../routing-policy.json", import.meta.url);',
			'export const repoPolicy = new URL("../repo-policy.json", import.meta.url);',
			'export { value } from "@klh/blam/src/fixture.ts";',
		].join("\n"),
	);
	put(
		"packages/suspenders/scripts/lib/agent-rules.ts",
		'import { resolve } from "node:path";\nexport const dir = resolve(import.meta.dir, "../../agent-rules");',
	);
	put("packages/buckle/upstreams.json", '{"groups":{"reviewed-default":[]}}');
	put("packages/local-llm/fixture.ts", "export const value = 1;");
	put("packages/blam/src/fixture.ts", "export const value = 1;");
	put("packages/blam/bench/paired/fixture.ts", "export const value = 1;");
	put("packages/blam/bench/improve/fixture.ts", "export const value = 1;");
	put(
		"packages/suspenders/install.sh",
		`#!/bin/sh\ntouch ${join(root, "service-called")}\n`,
	);
	git("init");
	git("add", ".");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed fixture",
	);
	const ctx: StepContext = {
		repo: join(source, "packages/suspenders"),
		prefix: join(root, "state/harness"),
		shimBin: join(root, "shims"),
		llmHome: join(root, "models"),
		home: join(root, "home"),
		dryRun: false,
		yes: true,
		json: true,
		verbose: true,
	};
	mkdirSync(ctx.prefix, { recursive: true });
	writeFileSync(join(ctx.prefix, "operator.env"), "private-preserved", {
		mode: 0o600,
	});
	writeFileSync(join(ctx.prefix, "old-code.ts"), "export const old = true;");
	return { root, source, ctx, git, put };
}

test("canonical step publishes a self-contained committed payload and receipt without service effects", async () => {
	const f = fixture();
	const result = await executePlan("step", "syncHarness", f.ctx, () => {});
	expect(result.outcome).toBe("ok");
	expect(result.rows.map((row) => row.name)).toEqual(["syncHarness"]);
	expect(lstatSync(f.ctx.prefix).isSymbolicLink()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
	const receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.revision).toBe(f.git("rev-parse", "HEAD"));
	expect(receipt.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(
		existsSync(
			join(f.ctx.prefix, ".harness/packages/buckle/src/server.bundle.js"),
		),
	).toBe(true);
	expect(
		existsSync(
			join(f.ctx.prefix, ".harness/packages/telemetry/src/http-trace.ts"),
		),
	).toBe(true);
	expect(
		statSync(
			join(f.ctx.prefix, ".harness/packages/buckle/src/server.bundle.js"),
		).mode & 0o222,
	).toBe(0);
	expect(existsSync(join(receipt.backup, "operator.env"))).toBe(true);
	expect(readFileSync(join(f.ctx.shimBin, "dispatch"), "utf8")).toContain(
		join(f.ctx.prefix, "scripts/dispatch-next.ts"),
	);
	expect(existsSync(join(f.root, "service-called"))).toBe(false);
	expect(existsSync(f.ctx.llmHome)).toBe(false);
	const packagedDefaults = join(
		f.ctx.prefix,
		".harness/packages/buckle/upstreams.json",
	);
	expect(readFileSync(packagedDefaults, "utf8")).toBe(
		f.git("show", `${receipt.revision}:packages/buckle/upstreams.json`),
	);
	// W1466: the payload is the computed closure — what an edge reaches
	// ships; trees nothing reaches (blam bench, deploy here) stay out.
	const staged = (rel: string) =>
		existsSync(join(f.ctx.prefix, ".harness/packages", rel));
	expect(staged("suspenders/agent-rules/fixture.ts")).toBe(true);
	expect(staged("local-llm/fixture.ts")).toBe(true);
	expect(staged("blam/src/fixture.ts")).toBe(true);
	expect(staged("blam/bench")).toBe(false);
	expect(staged("suspenders/deploy")).toBe(false);
	// W650: the scrub-gate stubs ride the prefix (symlinked from the payload).
	expect(lstatSync(join(f.ctx.prefix, ".githooks")).isSymbolicLink()).toBe(
		true,
	);
	expect(
		readFileSync(join(f.ctx.prefix, ".githooks/pre-commit"), "utf8"),
	).toContain("scrub-gate.ts");
	// W968: the W253 checkpoint roll rides the prefix as its own face —
	// the settings.json PreCompact hook targets this path.
	expect(lstatSync(join(f.ctx.prefix, "pre-compact.ts")).isSymbolicLink()).toBe(
		true,
	);
	// Runtime code and shared imports survive deletion of the source checkout.
	rmSync(f.source, { recursive: true, force: true });
	expect(readFileSync(packagedDefaults, "utf8")).toContain("reviewed-default");
	const imported = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			"console.log((await import(process.argv[1])).value)",
			join(f.ctx.prefix, "bin/work.ts"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(imported.exitCode).toBe(0);
	expect(imported.stdout.toString().trim()).toBe("1");
	expect(
		Bun.spawnSync([join(f.ctx.shimBin, "dispatch"), "--help"], {
			cwd: f.root,
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode,
	).toBe(0);
});

test("installed harness includes Belt dashboard dependencies", async () => {
	const f = fixture();
	f.put(
		"packages/belt/package.json",
		JSON.stringify({
			name: "belt",
			version: "1.0.0",
			type: "module",
			dependencies: { "bonjour-service": "1.4.4" },
		}),
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"belt dependency",
	);
	await syncHarness(f.ctx);
	const installed = JSON.parse(
		readFileSync(join(f.ctx.prefix, "package.json"), "utf8"),
	);
	expect(installed.dependencies["bonjour-service"]).toBe("1.4.4");
	expect(existsSync(join(f.ctx.prefix, "node_modules/bonjour-service"))).toBe(
		true,
	);
});

test("installed harness resolves staged Fleet packages locally", async () => {
	const f = fixture();
	f.put(
		"packages/suspenders/package.json",
		JSON.stringify({
			name: "@klh/suspenders",
			version: "2.0.0",
			type: "module",
			dependencies: { "@klh/blam": "2.0.0", "@klh/buckle": "2.0.0" },
		}),
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"scoped local dependencies",
	);
	await syncHarness(f.ctx);
	const installed = JSON.parse(
		readFileSync(join(f.ctx.prefix, "package.json"), "utf8"),
	);
	expect(installed.dependencies["@klh/blam"]).toBeUndefined();
	expect(installed.dependencies["@klh/buckle"]).toBeUndefined();
	expect(existsSync(join(f.ctx.prefix, "node_modules/@klh/blam"))).toBe(true);
	expect(existsSync(join(f.ctx.prefix, "node_modules/@klh/buckle"))).toBe(true);
});

// A25 (W1281.9): the private-name filter derives from the shipped manifests,
// not a hardcoded pair — a NEW private @klh package must install without the
// registry ever being consulted (the fixture has no @klh/* registry names;
// the offline resolver would fail the sync on any leaked private dep).
test("a new private staged package installs without consulting the registry", async () => {
	const f = fixture();
	f.put(
		"packages/telemetry/package.json",
		JSON.stringify({ name: "@klh/telemetry", version: "1.0.0", type: "module" }),
	);
	f.put(
		"packages/suspenders/package.json",
		JSON.stringify({
			name: "@klh/suspenders",
			version: "2.0.0",
			type: "module",
			dependencies: {
				"@klh/blam": "2.0.0",
				"@klh/buckle": "2.0.0",
				"@klh/telemetry": "1.0.0",
			},
		}),
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"third private dependency",
	);
	await syncHarness(f.ctx);
	const installed = JSON.parse(
		readFileSync(join(f.ctx.prefix, "package.json"), "utf8"),
	);
	expect(installed.dependencies["@klh/telemetry"]).toBeUndefined();
});

test.each(["syntax", "import", "execution"] as const)(
	"failed staged %s validation leaves original installation and keys intact",
	async (problem) => {
		const f = fixture(problem);
		await expect(syncHarness(f.ctx)).rejects.toThrow();
		expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
		expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
			"private-preserved",
		);
		expect(existsSync(join(f.ctx.prefix, "harness-receipt.json"))).toBe(false);
		expect(existsSync(`${f.ctx.prefix}.sync-lock`)).toBe(false);
	},
);

test("first directory migration restores the installation when pointer publication fails", async () => {
	const f = fixture();
	await expect(
		syncHarness(f.ctx, () => {
			throw new Error("publication denied");
		}),
	).rejects.toThrow("publication denied");
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
	expect(existsSync(join(f.ctx.shimBin, "coord"))).toBe(false);
});

test("a shim publication failure rolls back prefix and already replaced wrappers", async () => {
	const f = fixture();
	mkdirSync(f.ctx.shimBin);
	writeFileSync(join(f.ctx.shimBin, "coord"), "original coord");
	writeFileSync(join(f.ctx.shimBin, "work"), "original work");
	await expect(
		syncHarness(f.ctx, (source, destination) => {
			if (destination === join(f.ctx.shimBin, "work"))
				throw new Error("shim publication denied");
			renameSync(source, destination);
		}),
	).rejects.toThrow("shim publication denied");
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.shimBin, "coord"), "utf8")).toBe(
		"original coord",
	);
	expect(readFileSync(join(f.ctx.shimBin, "work"), "utf8")).toBe(
		"original work",
	);
});

test("repeat sync preserves private config permissions without nesting previous code snapshots", async () => {
	const f = fixture();
	await syncHarness(f.ctx);
	await syncHarness(f.ctx);
	expect(statSync(join(f.ctx.prefix, "operator.env")).mode & 0o777).toBe(0o600);
	expect(existsSync(join(f.ctx.prefix, ".harness/.harness"))).toBe(false);
	const imported = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			"console.log((await import(process.argv[1])).value)",
			join(f.ctx.prefix, "bin/work.ts"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(imported.exitCode).toBe(0);
});

test("dirty reviewed payload is refused before prefix changes", async () => {
	const f = fixture();
	f.put("packages/suspenders/hooks/gate.ts", "export const unreviewed = 2;");
	// W780: the verdict names the offending files — no stash-dance to find them.
	const error = await syncHarness(f.ctx).then(
		() => {
			throw new Error("expected dirty-guard rejection");
		},
		(e: Error) => e,
	);
	expect(error.message).toContain("working payload is dirty");
	expect(error.message).toContain("packages/suspenders/hooks/gate.ts");
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
});

test("unreviewed Buckle defaults are refused before prefix changes", async () => {
	const f = fixture();
	f.put("packages/buckle/upstreams.json", '{"groups":{"unreviewed":[]}}');
	await expect(syncHarness(f.ctx)).rejects.toThrow("working payload is dirty");
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
});

test("a payload face missing from the commit is refused before prefix changes", async () => {
	const f = fixture();
	f.git("rm", "-q", "packages/belt/bin/dashboard.ts");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed face removal",
	);
	// W1466: sourcePaths computes the ship list at the revision — a vanished
	// face refuses by name instead of archiving a payload with a hole.
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Payload faces vanished from the source tree: packages/belt/bin/dashboard.ts",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
});

test("offline dependency resolution produces a lock and staged import rather than a false success", async () => {
	const f = fixture();
	f.put(
		"packages/suspenders/package.json",
		JSON.stringify({
			name: "suspenders",
			version: "1.0.0",
			type: "module",
			dependencies: { blam: "workspace:*", zod: "^4.0.0" },
		}),
	);
	f.put(
		"packages/suspenders/hooks/board/prompt-transform.ts",
		'import { z } from "zod"; export const value = z.number().parse(1);',
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed production dependency",
	);
	await syncHarness(f.ctx);
	const receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.dependencyLockSha256).toMatch(/^[0-9a-f]{64}$/);
	expect(existsSync(join(f.ctx.prefix, "node_modules/zod/package.json"))).toBe(
		true,
	);
});

test("offlineResolveArgs freezes the resolver argv shape (W1050)", () => {
	expect(offlineResolveArgs()[1]).toBe("install");
	expect(offlineResolveArgs()).toContain("--offline");
	expect(offlineResolveArgs()).toContain("--ignore-scripts");
	expect(offlineResolveArgs()).toContain("--lockfile-only");
});

test("cold-cache ladder resolves offline when the cache is warm (W1050)", async () => {
	const f = fixture();
	const calls: string[][] = [];
	const run = async (argv: string[]): Promise<void> => {
		calls.push(argv);
	};
	await materializeDependencies(join(f.root, "stage"), run);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual(offlineResolveArgs());
});

test("cold-cache ladder fetches once and re-verifies offline (W1050)", async () => {
	const f = fixture();
	const calls: string[][] = [];
	const run = async (argv: string[]): Promise<void> => {
		calls.push(argv);
		if (argv.includes("--offline") && calls.length === 1)
			throw new Error("ENOENT: cache miss @clack/prompts");
	};
	await materializeDependencies(join(f.root, "stage"), run);
	expect(calls).toHaveLength(3);
	expect(calls[0]).toEqual(offlineResolveArgs());
	expect(calls[1]).not.toContain("--offline");
	expect(calls[1]).toContain("--ignore-scripts");
	expect(calls[1]).toContain("--lockfile-only");
	expect(calls[2]).toEqual(offlineResolveArgs());
});

test("cold-cache ladder fails early naming the remedy when both legs fail (W1050)", async () => {
	const f = fixture();
	const run = async (): Promise<void> => {
		throw new Error("network unreachable");
	};
	const error = await materializeDependencies(join(f.root, "stage"), run).then(
		() => null,
		(e: Error) => e,
	);
	expect(error?.message).toContain("warm the cache");
	expect(error?.message).toContain("network unreachable");
	// the verdict is the shared builder — same shape for direct callers
	expect(coldCacheVerdict("a", "b").message).toContain("fetch: b");
});

test("cold-cache production materialization succeeds offline when archives are cached (W1124.6)", async () => {
	const f = fixture();
	const calls: string[][] = [];
	const run = async (argv: string[]): Promise<void> => {
		calls.push(argv);
	};
	await materializeProduction(join(f.root, "stage"), run);
	expect(calls).toHaveLength(1);
	expect(calls[0]).toEqual(productionInstallArgs());
});

test("cold-cache production materialization fetches missing archives once and retries offline (W1124.6)", async () => {
	const f = fixture();
	const calls: string[][] = [];
	const run = async (argv: string[]): Promise<void> => {
		calls.push(argv);
		if (argv.includes("--offline") && calls.length === 1)
			throw new Error("ENOENT: cache miss dns-packet");
	};
	await materializeProduction(join(f.root, "stage"), run);
	expect(calls).toHaveLength(3);
	expect(calls[0]).toEqual(productionInstallArgs());
	// the one bounded fetch: same frozen graph, network, scripts disabled
	expect(calls[1]).toEqual(productionFetchArgs());
	expect(calls[2]).toEqual(productionInstallArgs());
});

test("failed archive fetch leaves the original error intact (W1124.6)", async () => {
	const f = fixture();
	const run = async (argv: string[]): Promise<void> => {
		if (argv.includes("--offline"))
			throw new Error("ENOENT: cache miss emoji-regex");
		throw new Error("network unreachable");
	};
	const error = await materializeProduction(join(f.root, "stage"), run).then(
		() => null,
		(e: Error) => e,
	);
	expect(error?.message).toContain("cache miss emoji-regex");
	expect(error?.message).not.toContain("network unreachable");
});

test("productionInstallArgs is the frozen offline materialization shape (W1124.6)", () => {
	const install = productionInstallArgs();
	expect(install[1]).toBe("install");
	expect(install).toContain("--production");
	expect(install).toContain("--offline");
	expect(install).toContain("--ignore-scripts");
	expect(install).toContain("--frozen-lockfile");
	// the fetch is the identical argv minus --offline: same frozen lock, no drift
	expect(productionFetchArgs()).toEqual(
		install.filter((a) => a !== "--offline"),
	);
	expect(productionFetchArgs()).not.toContain("--offline");
});

test("exclusive synchronization lock prevents simultaneous installers from publishing twice", async () => {
	const f = fixture();
	const results = await Promise.allSettled([
		syncHarness(f.ctx),
		syncHarness(f.ctx),
	]);
	expect(
		results.filter((result) => result.status === "fulfilled"),
	).toHaveLength(1);
	expect(results.filter((result) => result.status === "rejected")).toHaveLength(
		1,
	);
	expect(existsSync(`${f.ctx.prefix}.sync-lock`)).toBe(false);
});

test("setup failure releases the synchronization lock", async () => {
	const f = fixture();
	rmSync(f.ctx.prefix, { recursive: true });
	writeFileSync(f.ctx.prefix, "existing file");
	await expect(syncHarness(f.ctx)).rejects.toThrow();
	expect(existsSync(`${f.ctx.prefix}.sync-lock`)).toBe(false);
	expect(readFileSync(f.ctx.prefix, "utf8")).toBe("existing file");
});

test("archive remains pinned to the captured revision when HEAD advances", async () => {
	const f = fixture();
	const revision = f.git("rev-parse", "HEAD");
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("Git required for revision race regression");
	const wrapperDir = join(f.root, "git-wrapper");
	mkdirSync(wrapperDir);
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	writeFileSync(
		join(wrapperDir, "git"),
		`#!/bin/sh
if [ "$3" = archive ]; then
 printf '%s' 'export const value = 2;' > ${quote(join(f.source, "packages/suspenders/scripts/lib/shared.ts"))}
 ${quote(realGit)} -C ${quote(f.source)} add .
 ${quote(realGit)} -C ${quote(f.source)} -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm advanced
fi
exec ${quote(realGit)} "$@"
`,
		{ mode: 0o755 },
	);
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			"const {syncHarness}=await import(process.argv[1]); await syncHarness(JSON.parse(process.argv[2]));",
			join(import.meta.dir, "../scripts/sync-harness.ts"),
			JSON.stringify(f.ctx),
		],
		{
			env: { ...process.env, PATH: `${wrapperDir}:${process.env.PATH}` },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [code, error] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	expect(error).toBe("");
	expect(code).toBe(0);
	expect(f.git("rev-parse", "HEAD")).not.toBe(revision);
	const receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.revision).toBe(revision);
	expect(
		readFileSync(join(f.ctx.prefix, "scripts/lib/shared.ts"), "utf8"),
	).toContain("value = 1");
});

test("prune mirrors the prefix: unmanaged entries ride along only when allowlisted", async () => {
	const f = fixture();
	writeFileSync(join(f.ctx.prefix, "governor.db"), "runtime");
	mkdirSync(join(f.ctx.prefix, ".fleet"));
	writeFileSync(join(f.ctx.prefix, ".fleet", "brief.md"), "brief");
	// default sync preserves every unmanaged entry — the fork the mission named
	await syncHarness(f.ctx);
	expect(existsSync(join(f.ctx.prefix, "old-code.ts"))).toBe(true);
	let receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.pruned).toBeNull();
	// prune: mirror mode — non-allowlisted unmanaged entries drop
	const result = await syncHarness({ ...f.ctx, prune: true });
	expect(result.status).toBe("ok");
	expect(result.note).toContain(
		"pruned 2 unmanaged entries: old-code.ts, operator.env",
	);
	expect(existsSync(join(f.ctx.prefix, "old-code.ts"))).toBe(false);
	expect(existsSync(join(f.ctx.prefix, "operator.env"))).toBe(false);
	expect(readFileSync(join(f.ctx.prefix, "governor.db"), "utf8")).toBe(
		"runtime",
	);
	expect(readFileSync(join(f.ctx.prefix, ".fleet", "brief.md"), "utf8")).toBe(
		"brief",
	);
	receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.pruned).toEqual(["old-code.ts", "operator.env"]);
});
test("gateway dependency import failures abort publication without executing server", async () => {
	const f = fixture();
	f.put(
		"packages/buckle/src/server.ts",
		'import "./missing.ts"; throw new Error("must not execute");',
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed broken import fixture",
	);
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Staged gateway import graph failed",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
});

test("board entrypoint import graph failure aborts publication (W630)", async () => {
	const f = fixture();
	// The W630 incident shape: the board entry rode a staged generation whose
	// payload lacked buckle/src/projection.ts — validate() never resolved the
	// board graph, so the board crash-looped on the installed prefix.
	f.put(
		"packages/suspenders/hooks/bin/fleet-board.ts",
		'import "../../board/routes-observations.ts"; export const value = 1;',
	);
	f.put(
		"packages/suspenders/hooks/board/routes-observations.ts",
		'import "../../../buckle/src/projection.ts"; export const value = 1;',
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"reviewed board fixture missing projection",
	);
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Staged import graph failed (hooks/bin/fleet-board.ts)",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
});

test("registerGitHooks wires core.hooksPath on the source repo and verifies the stubs", async () => {
	const f = fixture();
	const result = await executePlan("step", "registerGitHooks", f.ctx, () => {});
	expect(result.outcome).toBe("ok");
	expect(result.rows).toHaveLength(1);
	expect(result.rows[0].status).toBe("ok");
	expect(result.rows[0].note).toContain("core.hooksPath=.githooks");
	const readBack = Bun.spawnSync(
		["git", "-C", f.source, "config", "core.hooksPath"],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(readBack.exitCode).toBe(0);
	expect(readBack.stdout.toString().trim()).toBe(".githooks");
});
test("registerGitHooks skips when the source repo is not a git checkout", async () => {
	const f = fixture();
	rmSync(join(f.source, ".git"), { recursive: true, force: true });
	const skipped = await executePlan(
		"step",
		"registerGitHooks",
		f.ctx,
		() => {},
	);
	expect(skipped.outcome).toBe("ok");
	expect(skipped.rows[0].status).toBe("skipped");
	expect(skipped.rows[0].note).toContain("not a git checkout");
});
test("registerGitHooks fails loud when a committed stub is missing", async () => {
	const f = fixture();
	rmSync(join(f.source, ".githooks/pre-commit"), { force: true });
	const result = await executePlan("step", "registerGitHooks", f.ctx, () => {});
	expect(result.outcome).toBe("failed");
	expect(result.rows[0].status).toBe("failed");
	expect(result.rows[0].note).toContain(
		"committed .githooks/pre-commit missing",
	);
});

test("sync refuses a source behind main — the shared runtime cannot regress (W1243)", async () => {
	const f = fixture();
	f.git("update-ref", "refs/heads/main", "HEAD");
	const base = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach");
	f.put(
		"packages/suspenders/scripts/lib/guard-fixture.ts",
		"export const value = 2;",
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"advance main past the stale source",
	);
	// main takes the advance; the tree parks behind it
	f.git("update-ref", "refs/heads/main", "HEAD");
	f.git("checkout", "--detach", base);
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Refusing to sync a source behind or diverged from main",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
});

test("a diverged source is refused the same way (W1243)", async () => {
	const f = fixture();
	const commit = (msg: string): void => {
		f.git(
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-m",
			msg,
		);
	};
	f.git("update-ref", "refs/heads/main", "HEAD");
	const base = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach");
	f.put(
		"packages/suspenders/scripts/lib/guard-fixture.ts",
		"export const value = 2;",
	);
	f.git("add", ".");
	commit("main advance");
	f.git("update-ref", "refs/heads/main", "HEAD");
	// park at base and grow a parallel line — neither descends from the other
	f.git("checkout", "--detach", base);
	f.put(
		"packages/suspenders/scripts/lib/guard-fixture.ts",
		"export const value = 3;",
	);
	f.git("add", ".");
	commit("parallel line");
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Refusing to sync a source behind or diverged from main",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
});

test("SUSPENDERS_SYNC_ALLOW_BRANCH=1 is the explicit lane-testing escape (W1243)", async () => {
	const f = fixture();
	f.git("update-ref", "refs/heads/main", "HEAD");
	const base = f.git("rev-parse", "HEAD");
	f.git("checkout", "--detach");
	f.put(
		"packages/suspenders/scripts/lib/guard-fixture.ts",
		"export const value = 2;",
	);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"advance main past the stale source",
	);
	f.git("checkout", "--detach", base);
	const prev = process.env.SUSPENDERS_SYNC_ALLOW_BRANCH;
	process.env.SUSPENDERS_SYNC_ALLOW_BRANCH = "1";
	try {
		await syncHarness(f.ctx);
	} finally {
		if (prev === undefined) delete process.env.SUSPENDERS_SYNC_ALLOW_BRANCH;
		else process.env.SUSPENDERS_SYNC_ALLOW_BRANCH = prev;
	}
	const receipt = JSON.parse(
		readFileSync(join(f.ctx.prefix, "harness-receipt.json"), "utf8"),
	);
	expect(receipt.revision).toBe(base);
});

// W1468: a kit twin publishes only as the full re-export of its belt/bin
// artifact — a byte copy is a second module instance (split pending map).
function commitTwin(f: ReturnType<typeof fixture>, kit: string): void {
	f.put("packages/belt/bin/spawner.ts", "export const pending = new Map();");
	f.put("packages/local-llm/spawner.ts", kit);
	f.git("add", ".");
	f.git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-m",
		"runtime twin",
	);
}

test("a diverged runtime twin is refused before publication (W1468)", async () => {
	const f = fixture();
	commitTwin(f, "export const pending = new Map();");
	await expect(syncHarness(f.ctx)).rejects.toThrow(
		"Runtime twins diverge from the pinned artifact",
	);
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
	expect(readFileSync(join(f.ctx.prefix, "operator.env"), "utf8")).toBe(
		"private-preserved",
	);
});

test("the published kit twin and its belt artifact are one module (W1468)", async () => {
	const f = fixture();
	commitTwin(f, '// shared lifecycle\nexport * from "../belt/bin/spawner.ts";');
	await syncHarness(f.ctx);
	const same = Bun.spawnSync(
		[
			process.execPath,
			"-e",
			"const [a, b] = await Promise.all(process.argv.slice(1).map((p) => import(p))); console.log(a.pending === b.pending)",
			join(f.ctx.prefix, "local-llm/spawner.ts"),
			join(f.ctx.prefix, ".harness/packages/belt/bin/spawner.ts"),
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	expect(same.exitCode).toBe(0);
	expect(same.stdout.toString().trim()).toBe("true");
});
