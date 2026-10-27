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
	const kind = marked ? { adapter_config: { proxy_kind: "litellm" } } : {};
	writeFileSync(
		join(dir, "upstreams.json"),
		JSON.stringify({
			version: 1,
			groups: {
				glm: [
					{
						url: "http://127.0.0.1:4100",
						dialect: "openai",
						model: "glm",
						...kind,
					},
					{ url: "https://plain.example/v1", dialect: "openai" },
				],
			},
		}),
	);
	writeFileSync(
		join(dir, "policy.json"),
		JSON.stringify({ version: 1, gateway: { num_retries: 1 } }),
	);
	writeFileSync(
		join(dir, "litellm.json"),
		JSON.stringify({
			model_list: [
				{
					model_name: "glm",
					litellm_params: {
						model: "zai/glm",
						api_base: "https://zai.example/v1",
					},
				},
			],
		}),
	);
	return {
		upstreamsPath: join(dir, "upstreams.json"),
		// Never written: with --stack the CLI sees no ambient machine stack,
		// so the fixture is the whole snapshot (hubs included).
		stackPath: join(dir, "stack.json"),
		env: {
			BUCKLE_POLICY: join(dir, "policy.json"),
			LITELLM_CONFIG: join(dir, "litellm.json"),
		},
	};
}

function preflight(fix: {
	upstreamsPath: string;
	stackPath: string;
	env: Record<string, string>;
}): { code: number; out: string } {
	const proc = Bun.spawnSync({
		// --upstreams is the BASE file (replaces the committed default) and
		// --stack replaces the machine stack; BUCKLE_UPSTREAMS is an
		// override-merge over ambient state and is deliberately stripped so
		// the fixture is the whole snapshot.
		cmd: [
			"bun",
			BIN,
			"--upstreams",
			fix.upstreamsPath,
			"--stack",
			fix.stackPath,
		],
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
	const fix = fixture(dir, true);
	writeFileSync(
		join(dir, "upstreams.json"),
		JSON.stringify({
			version: 1,
			groups: {
				glm: [
					{
						url: "http://127.0.0.1:4100",
						dialect: "openai",
						model: "ghost",
						adapter_config: { proxy_kind: "litellm" },
					},
				],
			},
		}),
	);
	const ghost = preflight(fix);
	expect(ghost.code).toBe(1);
	expect(ghost.out).toContain("unknown_engine_model");
	writeFileSync(join(dir, "upstreams.json"), "groups: [not, a, mapping\n");
	const broken = preflight(fix);
	expect(broken.code).toBe(2);
});

test("a missing live upstreams file fails closed (no silent committed fallback)", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const fix = fixture(dir, true);
	const proc = Bun.spawnSync({
		cmd: ["bun", BIN, "--upstreams", join(dir, "absent.json")],
		env: { ...process.env, ...fix.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(proc.exitCode).toBe(2);
	expect(proc.stderr.toString()).toContain("failed to load");
});

test("hub inventory from the real StackConfig shape resolves groups", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const fix = fixture(dir, true);
	const stackPath = join(dir, "stack.json");
	writeFileSync(
		stackPath,
		JSON.stringify({
			version: "1",
			hubs: {
				nas: {
					host: "nas.example",
					buckle_port: 4101,
					upstreams: {
						zai_litellm_url: "http://nas.example:4111",
						groups: {
							relay: [
								{ url: "https://provider.example/v1", dialect: "openai" },
							],
						},
					},
				},
			},
		}),
	);
	const ok = Bun.spawnSync({
		cmd: ["bun", BIN, "--upstreams", fix.upstreamsPath, "--stack", stackPath],
		env: { ...process.env, ...fix.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(ok.exitCode).toBe(0);
	expect(ok.stdout.toString()).toContain("1 hub(s)");
});

test("a hub-side engine never borrows this snapshot's config — its rows report unverified", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const fix = fixture(dir, true);
	const stackPath = join(dir, "stack.json");
	writeFileSync(
		stackPath,
		JSON.stringify({
			version: "1",
			hubs: {
				nas: {
					host: "nas.example",
					buckle_port: 4101,
					upstreams: {
						zai_litellm_url: "http://nas.example:4111",
						groups: {
							relay: [
								{
									url: "http://nas.example:4111",
									dialect: "openai",
									adapter_config: { proxy_kind: "litellm" },
								},
							],
						},
					},
				},
			},
		}),
	);
	const result = Bun.spawnSync({
		cmd: ["bun", BIN, "--upstreams", fix.upstreamsPath, "--stack", stackPath],
		env: { ...process.env, ...fix.env, BUCKLE_UPSTREAMS: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode).toBe(0);
	const out = result.stdout.toString();
	expect(out).toContain("unverified_engine");
	expect(out).not.toContain("unknown_engine_model");
});

test("a hub loopback leaf is a terminal only for the pool that declares it", () => {
	const dir = mkdtempSync(join(tmpdir(), "buckle-preflight-"));
	const fix = fixture(dir, true);
	const stackPath = join(dir, "stack.json");
	writeFileSync(
		stackPath,
		JSON.stringify({
			version: "1",
			hubs: {
				nas: {
					host: "nas.example",
					buckle_port: 4101,
					upstreams: {
						groups: {
							relay: [{ url: "http://127.0.0.1:9999", dialect: "openai" }],
						},
					},
				},
			},
		}),
	);
	writeFileSync(
		join(dir, "local-row.json"),
		JSON.stringify({
			version: 1,
			groups: { x: [{ url: "http://127.0.0.1:9999", dialect: "openai" }] },
		}),
	);
	const flagged = Bun.spawnSync({
		cmd: [
			"bun",
			BIN,
			"--upstreams",
			join(dir, "local-row.json"),
			"--stack",
			stackPath,
		],
		env: { ...process.env, ...fix.env, BUCKLE_UPSTREAMS: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(flagged.exitCode).toBe(1);
	expect(flagged.stdout.toString()).toContain("unmapped_local_target");
	// The HUB's own row onto the same leaf resolves: its pool declares it.
	const hubSide = Bun.spawnSync({
		cmd: ["bun", BIN, "--upstreams", fix.upstreamsPath, "--stack", stackPath],
		env: { ...process.env, ...fix.env, BUCKLE_UPSTREAMS: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(hubSide.exitCode).toBe(0);
});
