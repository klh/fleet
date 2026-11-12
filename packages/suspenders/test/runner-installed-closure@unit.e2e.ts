import {
	cpSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import {
	coveredByPayload,
	payloadClosure,
} from "../scripts/lib/source-closure.ts";
import { ENTRYPOINTS, PAYLOAD_FACES } from "../scripts/sync-harness.ts";

const repo = resolve(import.meta.dir, "../../..");
const runner = "hooks/bin/runner-control.ts";

async function currentClosure() {
	const tracked = Bun.spawnSync(
		["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{ cwd: repo },
	);
	expect(tracked.exitCode).toBe(0);
	return payloadClosure({
		repoRoot: repo,
		faces: PAYLOAD_FACES,
		tracked: tracked.stdout.toString().split("\0").filter(Boolean),
	});
}

test("default installed payload validates and includes the complete runner graph", async () => {
	expect(ENTRYPOINTS).toContain(runner);
	const closure = await currentClosure();
	expect(closure.missing).toEqual([]);
	for (const path of [
		"packages/suspenders/hooks/bin/runner-control.ts",
		"packages/suspenders/hooks/lib/runners/service/desktop-runtime.ts",
		"packages/suspenders/hooks/lib/runners/desktop/remote-process/guardian.ts",
		"packages/suspenders/hooks/lib/runners/desktop/leaf-handoff.ts",
		"packages/suspenders/hooks/lib/runners/durable/journal-anchor.ts",
		"packages/buckle/src/wire-schemas.ts",
	]) {
		expect(coveredByPayload(path, closure.paths), path).toBe(true);
		expect(closure.visited, path).toContain(path);
	}
});

test("runner imports build outside the checkout with only installed production dependencies", async () => {
	test.setTimeout(60_000);
	const world = scratchWorld({ prefix: "runner-install-closure-" });
	try {
		const closure = await currentClosure();
		expect(closure.missing).toEqual([]);
		const payload = join(world.repo, ".harness");
		for (const path of closure.paths) {
			const destination = join(payload, path);
			mkdirSync(dirname(destination), { recursive: true });
			cpSync(join(repo, path), destination, { recursive: true });
		}
		const manifests = closure.paths.filter((path) =>
			path.endsWith("/package.json"),
		);
		const members = new Map<string, string>();
		for (const path of manifests) {
			const item = JSON.parse(readFileSync(join(payload, path), "utf8"));
			members.set(item.name, dirname(path));
		}
		const dependencies: Record<string, string> = {};
		for (const name of ["suspenders", "belt"]) {
			const item = JSON.parse(
				readFileSync(join(payload, "packages", name, "package.json"), "utf8"),
			);
			for (const [name, version] of Object.entries(item.dependencies ?? {})) {
				if (
					typeof version === "string" &&
					!name.startsWith("@klh/") &&
					!version.startsWith("workspace:")
				)
					dependencies[name] = version;
			}
		}
		for (const path of manifests) {
			const file = join(payload, path);
			const item = JSON.parse(readFileSync(file, "utf8"));
			delete item.devDependencies;
			delete item.workspaces;
			for (const [name, version] of Object.entries(item.dependencies ?? {})) {
				if (
					!members.has(name) &&
					(name.startsWith("@klh/") ||
						(typeof version === "string" && version.startsWith("workspace:")))
				)
					delete item.dependencies[name];
			}
			writeFileSync(file, JSON.stringify(item));
		}
		writeFileSync(
			join(world.repo, "package.json"),
			JSON.stringify({
				name: "runner-installed-closure-test",
				private: true,
				type: "module",
				workspaces: [".harness/packages/*"],
				dependencies,
			}),
		);
		// Use the installer's production graph, refusing a cold cache rather
		// than entering its network-fetch fallback. No live prefix is touched.
		const install = Bun.spawnSync(
			[
				process.execPath,
				"install",
				"--production",
				"--offline",
				"--ignore-scripts",
			],
			{
				cwd: world.repo,
				env: process.env,
				timeout: 30_000,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(install.exitCode, install.stderr.toString()).toBe(0);
		for (const [name, directory] of members) {
			if (!name.startsWith("@klh/")) continue;
			const link = join(world.repo, "node_modules", name);
			mkdirSync(dirname(link), { recursive: true });
			rmSync(link, { recursive: true, force: true });
			symlinkSync(join(payload, directory), link);
		}
		const result = await Bun.build({
			entrypoints: [join(payload, "packages/suspenders", runner)],
			target: "bun",
			throw: false,
		});
		expect(result.success, result.logs.map(String).join("\n")).toBe(true);
	} finally {
		world.clean();
	}
});
