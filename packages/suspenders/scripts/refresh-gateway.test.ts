import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshGateway } from "./refresh-gateway.ts";

test("upgrade preserves custom runtime code and is idempotent", async () => {
	const runtime = await mkdtemp(join(tmpdir(), "fleet-gateway-"));
	try {
		await writeFile(
			join(runtime, "swarm.ts"),
			"async function serveOnce(): Promise<void> {\n}\n",
		);
		await writeFile(
			join(runtime, "spawner.ts"),
			[
				'import type { Specialist } from "./registry.ts";',
				"...(s.flags ?? []),",
				"if (wired > WIRED_GUARD_GB)",
				"// Stale row (recycled pid or wedged load) — clear and spawn fresh.\n\t\t\t\tclearLedgerPort(s.port);",
			].join("\n"),
		);
		const before = await readFile(join(runtime, "swarm.ts"), "utf8");
		await writeFile(
			join(runtime, "swarm.ts"),
			`${before}\n// operator customization\n`,
		);
		await refreshGateway(runtime, undefined, true);
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).not.toContain(
			"gatewaySupervisor",
		);
		await refreshGateway(runtime);
		const after = await readFile(join(runtime, "swarm.ts"), "utf8");
		expect(after).toContain("await ensureGateway()");
		expect(after).toContain("operator customization");
		expect(await readFile(join(runtime, "spawner.ts"), "utf8")).toContain(
			"refusing duplicate spawn",
		);
		await refreshGateway(runtime);
		expect(await readFile(join(runtime, "swarm.ts"), "utf8")).toBe(after);
	} finally {
		await rm(runtime, { recursive: true, force: true });
	}
});
