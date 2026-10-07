import { expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshSwarm } from "./refresh-swarm.ts";

test("staged validation retains operator registry re-exports to sibling Belt code", async () => {
	const fixtureValue = await fixture();
	const parent = await mkdtemp(join(tmpdir(), "fleet-swarm-siblings-"));
	const runtime = join(parent, "local-llm");
	try {
		await rename(fixtureValue.runtime, runtime);
		await mkdir(join(parent, "belt/bin"), { recursive: true });
		await writeFile(
			join(parent, "belt/bin/registry.ts"),
			fixtureValue.code["registry.ts"],
		);
		const wrapper = 'export * from "../belt/bin/registry.ts";';
		await writeFile(join(runtime, "registry.ts"), wrapper);
		await refreshSwarm(runtime);
		expect(await readFile(join(runtime, "registry.ts"), "utf8")).toBe(wrapper);
	} finally {
		await rm(fixtureValue.runtime, { recursive: true, force: true });
		await rm(parent, { recursive: true, force: true });
	}
});

async function fixture() {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-refresh-swarm-"));
	const code: Record<string, string> = {
		"swarm.ts":
			'async function serveOnce() {}\nswitch ("serve") { case "serve": break; }\n// customized old code\n',
		"registry.ts":
			"export const DOWNLOAD_MODELS=[], SPECIALISTS=[], EXTERNAL=[]; export const residentSet=()=>[];",
		"spawner.ts":
			"export const clearLedgerPort=()=>{}, mlxLogPath=()=>'', spawnArgs=()=>[], spawnReserved=()=>{};",
		"gateway-supervision.ts": "export const gatewaySupervisor=()=>async()=>{};",
		"litellm-target.ts":
			"export const litellmTarget=()=>({name:'test',port:4100});",
		"belt.env": "operator-owned placeholder",
		"routing-policy.yaml": "operator-owned ladder",
		"litellm.key": "test-placeholder",
	};
	await Promise.all(
		Object.entries(code).map(([file, body]) =>
			writeFile(join(runtime, file), body),
		),
	);
	return { runtime, code };
}

test("explicit code refresh validates the flattened runtime and preserves machine configuration", async () => {
	const { runtime, code } = await fixture();
	try {
		await refreshSwarm(runtime, undefined, true);
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).toBe(
			code["swarm.ts"],
		);
		await refreshSwarm(runtime);
		const refreshed = await readFile(join(runtime, "swarm.ts"), "utf8");
		expect(refreshed).toContain("await observe(");
		expect(refreshed).toContain("observedTargets(),");
		expect(refreshed).toContain("import.meta.main");
		expect(await readFile(join(runtime, "swarm.ts.serve-backup"), "utf8")).toBe(
			code["swarm.ts"],
		);
		for (const file of [
			"registry.ts",
			"belt.env",
			"routing-policy.yaml",
			"litellm.key",
			"gateway-supervision.ts",
		])
			expect(await readFile(join(runtime, file), "utf8")).toBe(code[file]);
		await refreshSwarm(runtime);
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).toBe(refreshed);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("validation failure cannot replace any runtime code", async () => {
	const { runtime, code } = await fixture();
	try {
		await expect(
			refreshSwarm(runtime, undefined, false, async () => {
				throw new Error("broken dependency");
			}),
		).rejects.toThrow("broken dependency");
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).toBe(
			code["swarm.ts"],
		);
		await refreshSwarm(runtime); // failure released refresh lock
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("advanced supervisor cannot be converted into a second kit supervisor", async () => {
	const { runtime } = await fixture();
	try {
		await writeFile(
			join(runtime, "swarm.ts"),
			'import { Supervisor } from "./supervisor.ts";',
		);
		await expect(refreshSwarm(runtime)).rejects.toThrow("refusing conversion");
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});

test("canonical installer selects kit refresh without running a full install", async () => {
	const { runtime, code } = await fixture();
	const home = await mkdtemp(join(tmpdir(), "fleet-refresh-home-"));
	try {
		await mkdir(join(home, ".claude"));
		await symlink(runtime, join(home, ".claude/local-llm"));
		const child = Bun.spawn(
			[
				"bash",
				join(import.meta.dir, "../install.sh"),
				"--refresh-supervisor",
				"--dry-run",
			],
			{
				env: { ...process.env, HOME: home },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = await new Response(child.stdout).text();
		expect(await child.exited).toBe(0);
		expect(output).toContain("Would replace kit runtime code");
		expect(output).not.toContain("installing to");
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).toBe(
			code["swarm.ts"],
		);
	} finally {
		await rm(runtime, { recursive: true, force: true });
		await rm(home, { recursive: true, force: true });
	}
});
