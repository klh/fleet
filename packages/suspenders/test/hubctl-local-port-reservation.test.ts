import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local hub render refuses a port reserved by the .local registry", () => {
	const home = mkdtempSync(join(tmpdir(), "hub-port-"));
	try {
		const registryDir = join(home, ".local/state/klh-local");
		mkdirSync(registryDir, { recursive: true });
		writeFileSync(
			join(registryDir, "registry.json"),
			JSON.stringify([{ name: "belt-mcp", port: 7793 }]),
		);
		const stack = join(home, "stack.json");
		const render = (beltPort: number) => {
			writeFileSync(
				stack,
				JSON.stringify({
					version: "reviewed-ref",
					hubs: {
						desktop: { host: "127.0.0.1", belt_port: beltPort },
					},
				}),
			);
			const p = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "../deploy/hubctl.ts"),
					"render",
					"desktop",
				],
				{
					env: { ...process.env, HOME: home, KLH_STACK: stack },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			return {
				code: p.exitCode,
				output: p.stdout.toString() + p.stderr.toString(),
			};
		};
		const conflict = render(7793);
		expect(conflict.code).not.toBe(0);
		expect(conflict.output).toContain("conflicts with belt-mcp");
		const clear = render(7808);
		expect(clear.code).toBe(0);
		expect(clear.output).toContain("HUB_BELT_PORT=7808");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
