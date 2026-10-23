// test/hubctl-upstreams-merge.test.ts — W990: operator hub upstream groups may
// carry YAML merge keys (the upstreams.copilot.yaml template shape —
// `<<: *copilot`). Neither the stack reader (W356 parse) nor buckle's loader
// resolves merges, so renderUpstreams resolves at render: a copied template
// row lands fully-specified (url/api_key_env present) instead of silently
// dead — the hub-ikea failure that left 24/26 template rows unroutable.
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
import { parse } from "yaml";
import { hubctlRouteFixture } from "./support/hubctl-route-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-merge-"));
mkdirSync(dir, { recursive: true });
const stack = join(dir, "stack.yaml");
const deployDir = join(dir, "hub");
const PIN = "v990-merge-test";

// A .yaml fixture (JSON cannot carry anchors/aliases): the claude-sonnet-5
// row anchors the shared copilot shape; the haiku row rides a merge key.
writeFileSync(
	stack,
	`version: ${PIN}
auth:
  required: false
hubs:
  w990:
    host: 127.0.0.1
    buckle_port: 14311
    deploy:
      dir: ${deployDir}
    upstreams:
      groups:
        claude-sonnet-5:
          - &copilot
            url: https://api.githubcopilot.example
            dialect: anthropic
            api_key_env: GITHUB_COPILOT_PAT
        claude-haiku-4-5:
          - <<: *copilot
            model: claude-haiku-4.5
`,
);

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

test("push renders merge-key template rows fully-specified", () => {
	const r = hubctl(["push", "w990"]);
	expect(r.out).not.toContain("Error");
	const text = readFileSync(join(deployDir, "upstreams.hub.yaml"), "utf8");
	const doc = parse(text) as {
		groups: Record<string, Array<Record<string, unknown>>>;
	};
	const haiku = doc.groups["claude-haiku-4-5"]?.[0];
	expect(haiku?.url).toBe("https://api.githubcopilot.example");
	expect(haiku?.model).toBe("claude-haiku-4.5");
	expect(haiku?.api_key_env).toBe("GITHUB_COPILOT_PAT");
	// the anchor row itself stays intact through the round-trip
	const sonnet = doc.groups["claude-sonnet-5"]?.[0];
	expect(sonnet?.url).toBe("https://api.githubcopilot.example");
	// no unresolved merge keys survive anywhere in the rendered ladder
	expect(text).not.toContain("<<");
});
