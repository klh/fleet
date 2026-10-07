import { expect, test } from "bun:test";
import { gatewaySupervisor } from "./gateway-supervision.ts";
import { modelBudgetGb, rapidMemoryArgs } from "./memory-policy.ts";

test("real listener can be adopted, then restarted after child exit", async () => {
	let clock = 0;
	let server = Bun.serve({
		port: 0,
		fetch: () => new Response("{}", { status: 401 }),
	});
	const port = server.port;
	let spawns = 0;
	let resolveExit = () => {};
	const tick = gatewaySupervisor(
		{
			name: "stub",
			port,
			kind: "gateway",
			owned: true,
			healthPath: "/v1/models",
			okStatus: [200, 401],
			spawn: () => {
				spawns++;
				server = Bun.serve({ port, fetch: () => new Response("{}") });
				return {
					pid: 1,
					exited: new Promise((resolve) => {
						resolveExit = () => resolve(0);
					}),
					kill: () => {
						server.stop(true);
						resolveExit();
					},
				};
			},
		},
		() => {},
		() => clock,
	);
	try {
		await tick();
		expect(spawns).toBe(0);
		server.stop(true);
		await tick();
		expect(spawns).toBe(1);
		await tick();
		expect(spawns).toBe(1);
		server.stop(true);
		resolveExit();
		await Promise.resolve();
		clock = 5000;
		await tick();
		expect(spawns).toBe(2);
	} finally {
		server.stop(true);
		resolveExit();
	}
});

test("gateway adopts healthy listener and revives exited children with backoff", async () => {
	let up = true;
	let clock = 0;
	let spawns = 0;
	let resolveExit = () => {};
	const tick = gatewaySupervisor(
		{
			name: "test",
			port: 4100,
			kind: "gateway",
			owned: true,
			spawn: () => {
				spawns++;
				return {
					pid: spawns,
					exited: new Promise((resolve) => {
						resolveExit = () => resolve(0);
					}),
					kill: () => resolveExit(),
				};
			},
		},
		() => {},
		() => clock,
		async () => up,
	);
	await tick();
	expect(spawns).toBe(0);
	up = false;
	await tick();
	expect(spawns).toBe(1);
	await tick();
	expect(spawns).toBe(1);
	resolveExit();
	await Promise.resolve();
	await tick();
	expect(spawns).toBe(1);
	clock = 5000;
	await tick();
	expect(spawns).toBe(2);
	resolveExit();
});

test("missing prerequisites back off without spawning or throwing", async () => {
	let checks = 0;
	const tick = gatewaySupervisor(
		{
			name: "test",
			port: 4100,
			kind: "gateway",
			owned: true,
			preflight: () => {
				checks++;
				return "missing runtime";
			},
			spawn: () => {
				throw new Error("must not spawn");
			},
		},
		() => {},
		() => 0,
		async () => false,
	);
	await tick();
	await tick();
	expect(checks).toBe(1);
});

test("hung owned child is killed only after bind grace and repeated failures", async () => {
	let clock = 0;
	let kills = 0;
	let resolveExit = () => {};
	const tick = gatewaySupervisor(
		{
			name: "test",
			port: 4100,
			kind: "gateway",
			owned: true,
			bindTimeoutMs: 1000,
			spawn: () => ({
				pid: 1,
				exited: new Promise((resolve) => {
					resolveExit = () => resolve(0);
				}),
				kill: () => {
					kills++;
					resolveExit();
				},
			}),
		},
		() => {},
		() => clock,
		async () => false,
	);
	await tick();
	await tick();
	expect(kills).toBe(0);
	clock = 5000;
	await tick();
	expect(kills).toBe(1);
	resolveExit();
});

test("model budgets reserve weight headroom and constrain concurrency and caches", () => {
	expect(modelBudgetGb(18)).toBe(26);
	expect(modelBudgetGb(22)).toBe(31);
	const args = rapidMemoryArgs(18, 128 * 2 ** 30);
	expect(Number(args[1]) * 128).toBe(26);
	expect(args).toContain("1024");
	expect(args).toContain("--idle-unload-seconds");
	expect(args[args.indexOf("--max-num-seqs") + 1]).toBe("2");
});
