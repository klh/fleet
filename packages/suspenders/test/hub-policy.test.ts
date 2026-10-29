import { expect, test } from "bun:test";
import { renderHubPolicy } from "../deploy/hub-policy.ts";
const base = JSON.stringify(
	{
		version: 1,
		gateway: {
			num_retries: 1,
			request_timeout_s: 120,
			first_byte_budget_s: 240,
			fallbacks: { primary: ["secondary"] },
		},
	},
	null,
	"\t",
);
test("absent hub gateway is byte-identical repository policy", () => {
	expect(renderHubPolicy(base)).toBe(base);
});
test("explicit zero retry and empty inner ladder survive rendering", () => {
	const p = JSON.parse(
		renderHubPolicy(base, { num_retries: 0, fallbacks: {} }),
	) as { gateway: Record<string, unknown> };
	expect(p.gateway.num_retries).toBe(0);
	expect(p.gateway.fallbacks).toEqual({});
	expect(p.gateway.request_timeout_s).toBe(120);
});
test("invalid walk/attempt policy is rejected before deployment", () => {
	expect(() => renderHubPolicy(base, { first_byte_budget_s: 10 })).toThrow();
});

test("fresh push materializes required policy before any up invocation", () => {
	const {
		mkdtempSync,
		readFileSync,
		writeFileSync,
		statSync,
		rmSync,
	} = require("node:fs");
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	const dir = mkdtempSync(join(tmpdir(), "hub-policy-push-"));
	try {
		const destination = join(dir, "fresh-hub");
		const stack = join(dir, "stack.json");
		writeFileSync(
			stack,
			JSON.stringify({
				version: "policy-test",
				hubs: {
					fresh: {
						host: "127.0.0.1",
						deploy: { dir: destination },
						buckle_gateway: { num_retries: 0, fallbacks: {} },
					},
				},
			}),
		);
		const run = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"push",
				"fresh",
			],
			{
				env: { ...process.env, KLH_STACK: stack },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (run.exitCode !== 0)
			throw new Error(run.stdout.toString() + run.stderr.toString());
		const file = join(destination, "routing-policy.hub.json");
		const policy = JSON.parse(readFileSync(file, "utf8")) as {
			gateway: { num_retries: number; fallbacks: Record<string, never> };
		};
		expect(policy.gateway.num_retries).toBe(0);
		expect(policy.gateway.fallbacks).toEqual({});
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const compose = readFileSync(join(destination, "hub-compose.yaml"), "utf8");
		expect(compose).toContain(
			"./routing-policy.hub.json:/etc/klh/routing-policy.hub.json:ro",
		);
		expect(compose).toContain(
			"BUCKLE_POLICY: /etc/klh/routing-policy.hub.json",
		);
		// Reload must replace the policy too, before recreating the container.
		const updated = JSON.parse(readFileSync(stack, "utf8"));
		updated.hubs.fresh.deploy.docker = "/usr/bin/true";
		updated.hubs.fresh.buckle_gateway.num_retries = 2;
		writeFileSync(stack, JSON.stringify(updated));
		const reload = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../deploy/hubctl.ts"),
				"reload-upstreams",
				"fresh",
			],
			{
				env: { ...process.env, KLH_STACK: stack },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		if (reload.exitCode !== 0)
			throw new Error(reload.stdout.toString() + reload.stderr.toString());
		const reloaded = JSON.parse(readFileSync(file, "utf8")) as {
			gateway: { num_retries: number };
		};
		expect(reloaded.gateway.num_retries).toBe(2);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
