import { expect, test } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	readFileSync,
	existsSync,
	rmSync,
	symlinkSync,
	readlinkSync,
	watch,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("GUI refresh rolls back broken installations and never writes config", () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-refresh-test-"));
	try {
		const prefix = join(home, "prefix");
		const entries = [
			join(home, ".claude/local-llm/dashboard.ts"),
			join(home, ".local/klh-local/bin/dashboard.ts"),
			join(prefix, "bin/fleet-board.ts"),
		];
		for (const entry of entries) {
			mkdirSync(join(entry, ".."), { recursive: true });
			writeFileSync(entry, "export const old = true;\n");
		}
		const config = join(home, ".claude/local-llm/registry.ts");
		writeFileSync(config, "export const operatorOwned = true;\n");
		const result = Bun.spawnSync(
			["bun", join(import.meta.dir, "../scripts/refresh-dashboards.ts")],
			{
				env: { ...process.env, HOME: home, SUSPENDERS_PREFIX: prefix },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(result.exitCode).not.toBe(0); // deliberately incomplete registry/dependencies
		for (const entry of entries)
			expect(readFileSync(entry, "utf8")).toBe("export const old = true;\n");
		expect(readFileSync(config, "utf8")).toBe(
			"export const operatorOwned = true;\n",
		);
		expect(existsSync(join(prefix, "board/recovery.ts"))).toBe(false);
		expect(existsSync(join(home, ".claude/local-llm/dashboard-state.ts"))).toBe(
			false,
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("failed GUI refresh never writes into immutable generation, even transiently", async () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-refresh-generation-"));
	let observer: ReturnType<typeof watch> | undefined;
	try {
		const generation = join(home, "generation");
		const prefix = join(home, "prefix");
		const board = join(generation, "bin/fleet-board.ts");
		mkdirSync(join(board, ".."), { recursive: true });
		writeFileSync(board, "export const captured = true;\n");
		const receipt = join(generation, "harness-receipt.json");
		writeFileSync(
			receipt,
			'{"revision":"captured","payloadSha256":"unchanged"}\n',
		);
		symlinkSync(generation, prefix);
		for (const entry of [
			join(home, ".claude/local-llm/dashboard.ts"),
			join(home, ".local/klh-local/bin/dashboard.ts"),
		]) {
			mkdirSync(join(entry, ".."), { recursive: true });
			writeFileSync(entry, "export const old = true;\n");
		}
		const changes: string[] = [];
		observer = watch(generation, { recursive: true }, (_event, name) => {
			changes.push(String(name));
		});
		const child = Bun.spawn(
			[
				Bun.which("bun") ?? "bun",
				join(import.meta.dir, "../scripts/refresh-dashboards.ts"),
			],
			{
				env: { ...Bun.env, HOME: home, SUSPENDERS_PREFIX: prefix },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		expect(await child.exited).not.toBe(0);
		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(changes).toEqual([]);
		expect(readlinkSync(prefix)).toBe(generation);
		expect(readFileSync(board, "utf8")).toBe("export const captured = true;\n");
		expect(readFileSync(receipt, "utf8")).toBe(
			'{"revision":"captured","payloadSha256":"unchanged"}\n',
		);
		expect(existsSync(join(generation, "board/routes-fleet-tree.ts"))).toBe(
			false,
		);
	} finally {
		observer?.close();
		rmSync(home, { recursive: true, force: true });
	}
});

import { chmodSync, statSync } from "node:fs";
import { refreshDashboards } from "../scripts/refresh-dashboards.ts";
import { syncHarness } from "../scripts/sync-harness.ts";

function capturedFixture() {
	const scratch = mkdtempSync(join(tmpdir(), "fleet-refresh-capture-"));
	const repo = join(scratch, "repo");
	const packageRoot = join(repo, "packages");
	const home = join(scratch, "home");
	const prefix = join(home, "prefix");
	const sourceFiles = {
		"belt/bin": [
			"dashboard.ts",
			"dashboard-state.ts",
			"health.ts",
			"remotes.ts",
			"inventory-probe.ts",
			"dashboard-observability.js",
			"klh-theme.ts",
			"vendor/lit.js",
		],
		"local/bin": [
			"dashboard.ts",
			"dashboard-health.ts",
			"health.ts",
			"klh-local.ts",
			"dashboard-page.html",
			"klh-theme.ts",
			"vendor/lit-shared.js",
		],
		"local-llm": ["observation.ts"],
	};
	for (const [pkg, files] of Object.entries(sourceFiles))
		for (const file of files) {
			const path = join(packageRoot, pkg, file);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(
				path,
				file.endsWith(".html")
					? "<p>captured</p>"
					: 'export const version = "captured";\n',
			);
		}
	mkdirSync(join(packageRoot, "suspenders"), { recursive: true });
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", repo, ...args], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		return result.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.email", "test@example.invalid");
	git("config", "user.name", "Fixture");
	git("add", "packages");
	git("commit", "-m", "captured dashboard fixture");
	const sha = git("rev-parse", "HEAD");
	const targets = [
		join(home, ".claude/local-llm/dashboard.ts"),
		join(home, ".local/klh-local/bin/dashboard.ts"),
	];
	for (const target of [...targets, join(prefix, "bin/fleet-board.ts")]) {
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, "export const old = true;\n");
	}
	chmodSync(targets[0], 0o600);
	chmodSync(targets[1], 0o751);
	return {
		scratch,
		home,
		prefix,
		packageRoot,
		sha,
		git,
		targets,
		options: { home, prefix, packageRoot },
	};
}

test("publication failure restores external bytes and original executable/private modes", async () => {
	const fixture = capturedFixture();
	let reachedPublisher = false;
	try {
		await expect(
			refreshDashboards(fixture.options, async (ctx) => {
				reachedPublisher = true;
				expect(ctx.expectedRevision).toBe(fixture.sha);
				for (const target of fixture.targets)
					expect(readFileSync(target, "utf8")).toContain("captured");
				throw new Error("injected publication failure");
			}),
		).rejects.toThrow("injected publication failure");
		expect(reachedPublisher).toBe(true);
		for (const target of fixture.targets)
			expect(readFileSync(target, "utf8")).toBe("export const old = true;\n");
		expect(statSync(fixture.targets[0]).mode & 0o777).toBe(0o600);
		expect(statSync(fixture.targets[1]).mode & 0o777).toBe(0o751);
		expect(existsSync(`${fixture.prefix}.refresh-lock`)).toBe(false);
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

test("concurrent committed source advance cannot mix external and harness revisions", async () => {
	const fixture = capturedFixture();
	try {
		await expect(
			refreshDashboards(fixture.options, async (ctx) => {
				expect(ctx.expectedRevision).toBe(fixture.sha);
				const source = join(fixture.packageRoot, "local/bin/dashboard.ts");
				writeFileSync(source, 'export const version = "new revision";\n');
				fixture.git("add", "packages/local/bin/dashboard.ts");
				fixture.git("commit", "-m", "concurrent source advance");
				expect(readFileSync(fixture.targets[1], "utf8")).toContain("captured");
				return syncHarness(ctx);
			}),
		).rejects.toThrow("Source revision changed");
		for (const target of fixture.targets)
			expect(readFileSync(target, "utf8")).toBe("export const old = true;\n");
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

test("outer refresh lock rejects overlapping updater before backup or writes", async () => {
	const fixture = capturedFixture();
	let release!: () => void;
	let publishing!: () => void;
	const entered = new Promise<void>((resolve) => {
		publishing = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let first: Promise<string> | undefined;
	try {
		first = refreshDashboards(fixture.options, async (ctx) => {
			publishing();
			await held;
			return { status: "ok", note: ctx.expectedRevision ?? "" };
		});
		await entered;
		const content = readFileSync(fixture.targets[0], "utf8");
		await expect(refreshDashboards(fixture.options)).rejects.toThrow();
		expect(readFileSync(fixture.targets[0], "utf8")).toBe(content);
		release();
		expect(await first).toContain(fixture.sha);
		expect(existsSync(`${fixture.prefix}.refresh-lock`)).toBe(false);
	} finally {
		release();
		await first?.catch(() => {});
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

test("dirty local dashboard sources refuse before external writes", async () => {
	const fixture = capturedFixture();
	try {
		writeFileSync(
			join(fixture.packageRoot, "local/bin/dashboard.ts"),
			'export const version = "uncommitted";\n',
		);
		await expect(refreshDashboards(fixture.options)).rejects.toThrow(
			"working payload is dirty",
		);
		for (const target of fixture.targets)
			expect(readFileSync(target, "utf8")).toBe("export const old = true;\n");
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});

test("captured symlink sources are refused before external mutation", async () => {
	const fixture = capturedFixture();
	try {
		const source = join(fixture.packageRoot, "local/bin/dashboard.ts");
		rmSync(source);
		symlinkSync(join(fixture.scratch, "mutable.ts"), source);
		writeFileSync(
			join(fixture.scratch, "mutable.ts"),
			"export const mutable = true;\n",
		);
		fixture.git("add", "packages/local/bin/dashboard.ts");
		fixture.git("commit", "-m", "symlink fixture");
		await expect(refreshDashboards(fixture.options)).rejects.toThrow(
			"regular files",
		);
		for (const target of fixture.targets)
			expect(readFileSync(target, "utf8")).toBe("export const old = true;\n");
	} finally {
		rmSync(fixture.scratch, { recursive: true, force: true });
	}
});
