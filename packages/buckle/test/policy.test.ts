// test/policy.test.ts — parse + defaults for the W124 policy shape.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	POLICY_DEFAULTS,
	loadGatewayPolicy,
	parsePolicy,
} from "../src/policy.ts";

test("parsePolicy: defaults when gateway section absent", () => {
	const p = parsePolicy("version: 1\n");
	expect(p.num_retries).toBe(1);
	expect(p.allowed_fails).toBe(3);
	expect(p.cooldown_time).toBe(30);
	expect(p.retry_max_delay_s).toBe(8);
	expect(p.request_timeout_s).toBe(120);
	expect(p.fallbacks).toBeUndefined();
});

test("parsePolicy: W124 ladder verbatim", () => {
	const yaml =
		"gateway:\n  fallbacks:\n    glm-5.3-flash: [local-swarm, gpt-5.2, claude-sonnet-5]\n";
	const p = parsePolicy(yaml);
	const ladder = p.fallbacks ? p.fallbacks["glm-5.3-flash"] : undefined;
	expect(ladder).toEqual(["local-swarm", "gpt-5.2", "claude-sonnet-5"]);
});

test("committed Claude fallback names GLM as a separate group", () => {
	const policy = loadGatewayPolicy(
		new URL("../routing-policy.yaml", import.meta.url).pathname,
	);
	expect(policy.fallbacks?.["claude-sonnet-5"]).toEqual([
		"glm-5.3-flash",
		"local-swarm",
	]);
});

test("parsePolicy: buckle knobs survive the shared-file shape", () => {
	const p = parsePolicy(
		"gateway:\n  retry_max_delay_s: 4\n  retry_after_cap_s: 30\n  request_timeout_s: 60\n",
	);
	expect(p.retry_max_delay_s).toBe(4);
	expect(p.retry_after_cap_s).toBe(30);
	expect(p.request_timeout_s).toBe(60);
});

test("POLICY_DEFAULTS: fixed constants from the ported semantics", () => {
	expect(POLICY_DEFAULTS).toEqual({
		num_retries: 1,
		allowed_fails: 3,
		cooldown_time: 30,
		retry_max_delay_s: 8,
		retry_after_cap_s: 60,
		request_timeout_s: 120,
		// W450 long-generation deadlines
		stream_idle_timeout_s: 60,
		stream_total_timeout_s: 900,
	});
});

test("JSON policy retains Buckle-specific tags and aids", () => {
	const policy = parsePolicy(
		JSON.stringify({
			version: 1,
			gateway: { num_retries: 2, retry_after_cap_s: 9 },
			tags: { glm: ["code"] },
			aids: { "cache-align": { default: "off" } },
		}),
	);
	expect(policy.num_retries).toBe(2);
	expect(policy.retry_after_cap_s).toBe(9);
	expect(policy.tags).toEqual({ glm: ["code"] });
	expect(policy.aids?.["cache-align"]?.default).toBe("off");
});

test("JSON sibling of a pinned YAML policy wins, with YAML fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "w975-buckle-policy-"));
	const yaml = join(dir, "routing-policy.yaml");
	const json = join(dir, "routing-policy.json");
	try {
		writeFileSync(yaml, "gateway:\n  num_retries: 2\n");
		writeFileSync(json, JSON.stringify({ gateway: { num_retries: 3 } }));
		expect(loadGatewayPolicy(yaml).num_retries).toBe(3);
		writeFileSync(json, "gateway:\n  num_retries: 4\n");
		expect(() => loadGatewayPolicy(yaml)).toThrow();
		rmSync(json);
		expect(loadGatewayPolicy(yaml).num_retries).toBe(2);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runtime JSON wins over runtime YAML", () => {
	const dir = mkdtempSync(join(tmpdir(), "w975-buckle-home-"));
	const runtime = join(dir, ".claude", "local-llm");
	const previousHome = process.env.HOME;
	const previousBuckle = process.env.BUCKLE_POLICY;
	const previousBelt = process.env.BELT_POLICY;
	try {
		mkdirSync(runtime, { recursive: true });
		writeFileSync(
			join(runtime, "routing-policy.yaml"),
			"gateway:\n  num_retries: 2\n",
		);
		writeFileSync(
			join(runtime, "routing-policy.json"),
			JSON.stringify({ gateway: { num_retries: 3 } }),
		);
		process.env.HOME = dir;
		delete process.env.BUCKLE_POLICY;
		delete process.env.BELT_POLICY;
		expect(loadGatewayPolicy().num_retries).toBe(3);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousBuckle === undefined) delete process.env.BUCKLE_POLICY;
		else process.env.BUCKLE_POLICY = previousBuckle;
		if (previousBelt === undefined) delete process.env.BELT_POLICY;
		else process.env.BELT_POLICY = previousBelt;
		rmSync(dir, { recursive: true, force: true });
	}
});
