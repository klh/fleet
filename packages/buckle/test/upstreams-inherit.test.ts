// test/upstreams-inherit.test.ts — W1123 hub identity: `inherit_defaults:
// false` on an override declares it the WHOLE pool; the committed base
// ladder (Mac local-swarm :890x) never merges underneath, so an empty or
// unconfigured hub exposes zero fake local rows. Absent = merge-over-base.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpstreams, mergeUpstreams } from "../src/upstreams.ts";

const dirs: string[] = [];
const scratch = (): string => {
	const d = mkdtempSync(join(tmpdir(), "buckle-inherit-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Load the committed base ladder with `over` riding BUCKLE_UPSTREAMS;
 *  `httpHosts` feeds the egress allowlist for plain-http private fixtures. */
function loadWithOverride(over: string, httpHosts?: string) {
	process.env.BUCKLE_UPSTREAMS = over;
	if (httpHosts) process.env.BUCKLE_HTTP_UPSTREAM_HOSTS = httpHosts;
	try {
		return loadUpstreams();
	} finally {
		delete process.env.BUCKLE_UPSTREAMS;
		delete process.env.BUCKLE_HTTP_UPSTREAM_HOSTS;
	}
}

describe("inherit_defaults (W1123)", () => {
	test("false replaces the base ladder wholesale", () => {
		const merged = mergeUpstreams(
			{
				groups: {
					"local-swarm": [{ url: "http://127.0.0.1:8902", dialect: "openai" }],
				},
			},
			{ inherit_defaults: false, groups: { hub: [] } },
		);
		expect(Object.keys(merged.groups).sort()).toEqual(["hub"]);
	});

	test("absent keeps merge-over-base (Mac spoke override unchanged)", () => {
		const merged = mergeUpstreams(
			{
				groups: {
					"local-swarm": [{ url: "http://127.0.0.1:8902", dialect: "openai" }],
				},
			},
			{ groups: { hub: [] } },
		);
		expect(Object.keys(merged.groups).sort()).toEqual(["hub", "local-swarm"]);
	});

	test("an unconfigured hub exposes no local-swarm rows via BUCKLE_UPSTREAMS", () => {
		const over = join(scratch(), "upstreams.hub.json");
		writeFileSync(
			over,
			JSON.stringify({ version: 1, inherit_defaults: false, groups: {} }),
		);
		const pool = loadWithOverride(over);
		expect(pool.groups()).toEqual([]);
		expect(pool.deployments("local-swarm")).toEqual([]);
		expect(pool.deployments("glm-5.3-flash")).toEqual([]);
	});

	test("a configured-but-missing BUCKLE_UPSTREAMS is startup fatal (W1123)", () => {
		expect(() =>
			loadWithOverride("/nonexistent/buckle-hub-mount.yaml"),
		).toThrow(/configured but missing/);
	});

	test("a hub ladder serves only its own groups under the flag", () => {
		const over = join(scratch(), "upstreams.hub.yaml");
		writeFileSync(
			over,
			JSON.stringify({
				version: 1,
				inherit_defaults: false,
				groups: {
					"claude-haiku-4-5": [
						{
							url: "http://engine.example:4100",
							dialect: "anthropic",
							api_key_env: "LITELLM_KEY",
						},
					],
				},
			}),
		);
		const pool = loadWithOverride(over, "engine.example");
		expect(pool.groups()).toEqual(["claude-haiku-4-5"]);
		expect(pool.deployments("local-swarm")).toEqual([]);
	});
});
