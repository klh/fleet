// test/hubctl-upstreams-json.test.ts — W2183 re-port of W990 onto the JSON
// stack config: operator hub upstream groups (the upstreams.copilot.json
// template shape) render fully-specified through renderUpstreams. The yaml
// merge-key resolution is GONE by construction — JSON.parse (the ONE
// parser) cannot carry `<<:` anchors, so the yaml parse/stringify roundtrip
// the original W990 branch added is not ported; what carries over is the
// guarantee: every copied template row lands fully-specified (url,
// api_key_env present) instead of silently dead — the hub-ikea failure that
// left 24/26 template rows unroutable.
import { afterAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubctlRouteFixture } from "./support/hubctl-route-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-json-"));
mkdirSync(dir, { recursive: true });
const PIN = "v2183-json-test";
const stack = join(dir, "stack.json");
const deployDir = join(dir, "hub");

function stackDoc(): Record<string, unknown> {
	return {
		version: PIN,
		auth: { required: false },
		hubs: {
			w990: {
				host: "127.0.0.1",
				buckle_port: 14311,
				deploy: { dir: deployDir },
				upstreams: {
					groups: {
						"claude-sonnet-5": [
							{
								url: "https://api.githubcopilot.example",
								dialect: "anthropic",
								api_key_env: "GITHUB_COPILOT_PAT",
							},
						],
						"claude-haiku-4-5": [
							{
								url: "https://api.githubcopilot.example",
								dialect: "anthropic",
								api_key_env: "GITHUB_COPILOT_PAT",
								model: "claude-haiku-4.5",
							},
						],
					},
				},
			},
		},
	};
}

writeFileSync(stack, JSON.stringify(stackDoc(), null, "\t"));

function hubctl(args: string[]): { code: number; out: string } {
	const r = Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "../deploy/hubctl.ts"), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...hubctlRouteFixture(dir), KLH_STACK: stack },
		},
	);
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("push renders JSON upstream groups fully-specified", () => {
	const r = hubctl(["push", "w990"]);
	expect(r.out).not.toContain("Error");
	const text = readFileSync(join(deployDir, "upstreams.hub.json"), "utf8");
	const doc = JSON.parse(text) as {
		groups: Record<string, Array<Record<string, unknown>>>;
	};
	const haiku = doc.groups["claude-haiku-4-5"]?.[0];
	expect(haiku?.url).toBe("https://api.githubcopilot.example");
	expect(haiku?.model).toBe("claude-haiku-4.5");
	expect(haiku?.api_key_env).toBe("GITHUB_COPILOT_PAT");
	// the anchor-equivalent row itself stays intact through the render
	const sonnet = doc.groups["claude-sonnet-5"]?.[0];
	expect(sonnet?.url).toBe("https://api.githubcopilot.example");
	// JSON cannot carry merge keys — none survive anywhere in the ladder
	expect(text).not.toContain("<<");
});
