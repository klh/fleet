import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("Pi awareness degrades each failed source independently without leaking stderr @unit", async () => {
	const { loadSnapshot } = await import(
		"../pi-extensions/fleet-awareness/client.ts"
	);
	const snapshot = await loadSnapshot(
		async (command, args) => {
			if (command === "work")
				return {
					stdout: "",
					stderr: "private-value",
					code: 2,
					killed: true,
					truncated: false,
				};
			return {
				stdout:
					args[0] === "hubs" ? JSON.stringify({ hubs: [{ up: true }] }) : "[]",
				stderr: "",
				code: 0,
				killed: false,
				truncated: false,
			};
		},
		"/fixture",
		"pi-fixture",
	);
	expect(snapshot.hubs.state).toBe("invalid");
	expect(snapshot.work.state).toBe("unavailable");
	expect(snapshot.peers.state).toBe("ok");
	expect(JSON.stringify(snapshot)).not.toContain("private-value");
});

test("Pi awareness uses bounded scoped CLI snapshots, with unknown capacity preserved @unit", async () => {
	const { loadSnapshot } = await import(
		"../pi-extensions/fleet-awareness/client.ts"
	);
	const world = scratchWorld({ prefix: "pi-aware-" });
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const run = async (command: string, args: string[], options: unknown) => {
		calls.push({ command, args, options });
		const value =
			command === "work"
				? {
						schema_version: 1,
						generated_at: new Date(1000).toISOString(),
						items: [],
						needs_you: { count: 0, ids: [] },
						capacity: null,
						model_health: { down: [] },
					}
				: args[0] === "hubs"
					? {
							hubs: [
								{
									label: "fixture",
									up: true,
									url: "http://fixture.invalid",
									models: null,
									pools: [],
									candidates: [],
									apiKey: "private-value",
								},
							],
						}
					: [];
		return {
			stdout: JSON.stringify(value),
			stderr: "",
			code: 0,
			killed: false,
			truncated: false,
		};
	};
	try {
		const snapshot = await loadSnapshot(
			run,
			world.home,
			"pi-fixture",
			undefined,
			() => 1000,
		);
		expect(snapshot.hubs.state).toBe("ok");
		expect(snapshot.hubs.value?.[0].models).toBeNull();
		expect(snapshot.work.value?.capacity).toBeNull();
		expect(JSON.stringify(snapshot)).not.toContain("private-value");
		expect(calls).toHaveLength(3);
		expect(calls.every((c) => ["coord", "work"].includes(c.command))).toBe(
			true,
		);
		expect(calls.find((c) => c.command === "work")?.args).toContain(
			"pi-fixture",
		);
		for (const c of calls)
			expect(c.options).toMatchObject({
				cwd: world.home,
				timeout: 8000,
				maxBuffer: 524288,
			});
	} finally {
		world.clean();
	}
});

test("Pi CLI source distinguishes malformed JSON from unavailable transport @unit", async () => {
	const { readSource } = await import(
		"../pi-extensions/fleet-awareness/client.ts"
	);
	const { PeersSchema } = await import(
		"../pi-extensions/fleet-awareness/contracts.ts"
	);
	for (const [stdout, truncated, expected] of [
		["{broken", false, "invalid"],
		["[]", true, "unavailable"],
	] as const) {
		const source = await readSource(
			async () => ({
				stdout,
				truncated,
				stderr: "secret",
				code: 0,
				killed: false,
			}),
			"coord",
			["targets", "--json"],
			"/fixture",
			PeersSchema,
		);
		expect(source.state).toBe(expected);
		expect(source.value).toBeNull();
	}
	const source = await readSource(
		async () => {
			throw new Error("secret");
		},
		"coord",
		["targets", "--json"],
		"/fixture",
		PeersSchema,
	);
	expect(source.state).toBe("unavailable");
});
