import { afterEach, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executePlan, type StepContext } from "../scripts/install-run.ts";
import { syncHarness } from "../scripts/sync-harness.ts";

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
	for (const name of ["suspenders", "belt", "local-llm", "blam"])
		put(
			`packages/${name}/package.json`,
			JSON.stringify({
				name,
				version: "1.0.0",
				type: "module",
				dependencies: name === "suspenders" ? { blam: "workspace:*" } : {},
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
	for (const file of [
		"gate.ts",
		"session-start.ts",
		"session-end.ts",
		"statusline.ts",
		"subagent-statusline.ts",
		"bin/coord.ts",
		"bin/work.ts",
		"bin/fleet-loop.ts",
		"bin/fleet-tracker.ts",
		"bin/fleet-watch.ts",
		"bin/morph.ts",
		"lib/morph.ts",
		"board/prompt-transform.ts",
	])
		put(`packages/suspenders/hooks/${file}`, "export const value = 1;");
	for (const file of ["dispatch-next.ts", "supervise.ts"])
		put(`packages/suspenders/scripts/${file}`, "export const value = 1;");
	put("packages/suspenders/hooks/knowledgeworker.md", "fixture");
	put("packages/suspenders/deploy/services.yaml", "services: []");
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
	put("packages/belt/bin/fixture.ts", "export const value = 1;");
	put(
		"packages/buckle/upstreams.yaml",
		"groups:\n  fixture:\n    - name: reviewed-default\n      tier: 4\n",
	);
	put("packages/local-llm/fixture.ts", "export const value = 1;");
	put("packages/blam/src/fixture.ts", "export const value = 1;");
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
	expect(existsSync(join(receipt.backup, "operator.env"))).toBe(true);
	expect(readFileSync(join(f.ctx.shimBin, "dispatch"), "utf8")).toContain(
		join(f.ctx.prefix, "scripts/dispatch-next.ts"),
	);
	expect(existsSync(join(f.root, "service-called"))).toBe(false);
	expect(existsSync(f.ctx.llmHome)).toBe(false);
	const packagedDefaults = join(
		f.ctx.prefix,
		".harness/packages/buckle/upstreams.yaml",
	);
	expect(readFileSync(packagedDefaults, "utf8")).toBe(
		`${f.git("show", `${receipt.revision}:packages/buckle/upstreams.yaml`)}\n`,
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
	await expect(syncHarness(f.ctx)).rejects.toThrow("working payload is dirty");
	expect(lstatSync(f.ctx.prefix).isDirectory()).toBe(true);
});

test("unreviewed Buckle defaults are refused before prefix changes", async () => {
	const f = fixture();
	f.put("packages/buckle/upstreams.yaml", "groups: { unreviewed: [] }");
	await expect(syncHarness(f.ctx)).rejects.toThrow("working payload is dirty");
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
