// test/preflight.test.ts — W1094: the release preflight CLI validates the
// LIVE config surface (fixture HOME via env overrides) and fails closed:
// missing proxy_kind on an engine row, unknown engine wire model, or a
// broken config file each refuse activation with a machine-parseable line.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../bin/preflight.ts", import.meta.url).pathname;

function fixture(dir: string, marked: boolean): Record<string, string> {
	const kind = marked
		? "\n      adapter_config:\n        proxy_kind: litellm"
		: "";
	writeFileSync(
		join(dir, "upstreams.yaml"),
		`version: 1
groups:
  glm:
    - url: http://127.0.0.1:4100
      dialect: openai
      model: glm${kind}
    - url: https://plain.example/v1
      dialect: openai
`,
	);
	writeFileSync(
		join(dir, "policy.yaml"),
		"version: 1\ngateway:\n  num_retries: 1\n",
	);
	writeFileSync(
		join(dir, "litellm.yaml"),
		`model_list:
  - model_name: glm
    litellm_params:
      model: zai/glm
      api_base: https://zai.example/v1
`,
	);
	return {
		upstreamsPath: join(dir, "upstreams.yaml"),
		env: {
			BUCKLE_POLICY: join(dir, "policy.yaml"),
			LITELLM_CONFIG: join(dir, "litellm.yaml"),
		},
	};
}

function preflight(fix: {
	upstreamsPath: string;
	env: Record<string, string>;
}): { code: number; out: string } {
	const proc = Bun.spawnSync({
		// --upstreams is the BASE file (replaces the committed default);
		// BUCKLE_UPSTREAMS is an override-merge over ambient state and is
		// deliberately stripped so the fixture is the whole snapshot.
		cmd: ["bun", BIN, "--upstreams", fix.upstreamsPath],
		env: {
			...process.env,
			...fix.env,
			BUCKLE_UPSTREAMS: "",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode ?? -1,
		out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
	};
}

test("an engine row without proxy_kind fails the live-config preflight", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const result = preflight(fixture(dir, false));
	expect(result.code).toBe(1);
	expect(result.out).toContain("missing_proxy_kind");
});

test("a marked engine row with a known wire model passes clean", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const result = preflight(fixture(dir, true));
	expect(result.code).toBe(0);
	expect(result.out).toContain("clean");
});

test("an unknown engine wire model and a broken config fail closed", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const env = fixture(dir, true);
	writeFileSync(
		join(dir, "upstreams.yaml"),
		`version: 1
groups:
  glm:
    - url: http://127.0.0.1:4100
      dialect: openai
      model: ghost
      adapter_config:
        proxy_kind: litellm
`,
	);
	const ghost = preflight(env);
	expect(ghost.code).toBe(1);
	expect(ghost.out).toContain("unknown_engine_model");
	writeFileSync(join(dir, "upstreams.yaml"), "groups: [not, a, mapping\n");
	const broken = preflight(env);
	expect(broken.code).toBe(2);
});
