import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshGateway } from "../scripts/refresh-gateway.ts";
const runtime = mkdtempSync(join(tmpdir(), "fleet-memory-refresh-"));
afterAll(() => rmSync(runtime, { recursive: true, force: true }));
const old = (path: string) => {
	const p = Bun.spawnSync(["git", "show", `HEAD:${path}`]);
	if (p.exitCode !== 0)
		throw new Error("could not load baseline runtime fixture");
	return p.stdout.toString();
};

test("minimal runtime upgrade wires both launch paths and preserves config/customization", async () => {
	writeFileSync(
		join(runtime, "swarm.ts"),
		`${old("packages/local-llm/swarm.ts")}\n// custom-operator-marker\n`,
	);
	writeFileSync(
		join(runtime, "spawner.ts"),
		old("packages/belt/bin/spawner.ts"),
	);
	writeFileSync(join(runtime, "belt.env"), "OPERATOR_CONFIG=keep\n");
	await refreshGateway(runtime);
	const swarm = readFileSync(join(runtime, "swarm.ts"), "utf8");
	expect(swarm).toContain("spawnReserved(s).unref()");
	expect(swarm).toContain("spawnReserved(specialist)");
	expect(swarm).toContain("custom-operator-marker");
	expect(readFileSync(join(runtime, "spawner.ts"), "utf8")).toContain(
		"admitSpawn",
	);
	expect(readFileSync(join(runtime, "spawn-admission.ts"), "utf8")).toContain(
		"BEGIN IMMEDIATE",
	);
	expect(readFileSync(join(runtime, "belt.env"), "utf8")).toBe(
		"OPERATOR_CONFIG=keep\n",
	);
	await refreshGateway(runtime);
	expect(readFileSync(join(runtime, "swarm.ts"), "utf8")).toBe(swarm);
});
