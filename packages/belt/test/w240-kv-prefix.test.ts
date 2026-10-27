// W240 — kv-prefix unit tests. No model loads: python is an injected exec
// fake; the warm tests ride an in-process Bun.serve stub.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchWorld, serveStub } from "../../test-kit/src/index.ts";
import {
	buildPacket,
	type Exec,
	type ExecResult,
	loadPacketPrefix,
	latestKvMeta,
	probeFromHelp,
	probeServer,
	prefixSha,
	readProbe,
	serverKvArgs,
	systemText,
	verifyPacket,
	warmAll,
	warmOpenaiBody,
	warmSpecialist,
} from "../bin/kv-prefix.ts";

const { home: HOME, clean } = scratchWorld({ prefix: "fleet-kv-prefix-" });
afterAll(() => clean());

const PREFIX = {
	capturedAt: 1,
	model: "claude-fable-5-1",
	tools: [{ name: "Bash", description: "run size" }],
	system: [
		{ type: "text", text: "You are lane W240." },
		{ type: "text", text: "text two" },
	],
};

const SHA = "a".repeat(64);
const ok = (stdout: string): ExecResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});

// Fake python: render and prefill both report the same stable idsSha (the
// cross-check buildPacket enforces); prefill also writes the cache file.
const fakeExec: Exec = async (argv, input) => {
	const cfg = JSON.parse(input) as { out?: string };
	if ((argv[2] ?? "").includes("generate_step")) {
		if (cfg.out) {
			mkdirSync(cfg.out.slice(0, cfg.out.lastIndexOf("/")), {
				recursive: true,
			});
			writeFileSync(cfg.out, Buffer.alloc(2048));
		}
		return ok(
			`${JSON.stringify({ tokenCount: 42, idsSha: SHA, seconds: 1.5, mlxLmVersion: "0.31.3", cacheBytes: 2048 })}\n`,
		);
	}
	return ok(`${JSON.stringify({ tokenCount: 42, idsSha: SHA })}\n`);
};

// Minimal valid KvMeta for the dir-listing tests.
const metaFor = (idsSha: string, createdAt: string) => ({
	version: 1,
	kind: "belt-kv-prefix",
	model: "test/model",
	idsSha,
	prefixSha: "0123456789abcdef",
	tokenCount: 9,
	kvBits: 8,
	kvGroupSize: 64,
	quantizedKvStart: 1_000,
	mlxLmVersion: "0.31.3",
	cacheBytes: 2048,
	prefix: PREFIX,
	createdAt,
});

test("prefixSha is stable and text-sensitive", () => {
	const a = prefixSha(PREFIX);
	expect(prefixSha(PREFIX)).toBe(a);
	expect(prefixSha({ ...PREFIX, system: "plain string" })).not.toBe(a);
	expect(a).toMatch(/^[0-9a-f]{16}$/);
});

test("systemText flattens content blocks like the server does", () => {
	expect(systemText(PREFIX.system)).toBe("You are lane W240.\ntext two");
	expect(systemText("plain")).toBe("plain");
	expect(systemText(42)).toBe("");
});

test("loadPacketPrefix validates the capture shape", () => {
	const path = join(HOME, "prefix-cache.json");
	writeFileSync(path, JSON.stringify(PREFIX));
	expect(loadPacketPrefix(path)?.tools.length).toBe(1);
	writeFileSync(path, JSON.stringify({ model: "x" }));
	expect(loadPacketPrefix(path)).toBeNull();
	expect(loadPacketPrefix(join(HOME, "missing.json"))).toBeNull();
});

test("buildPacket renders, prefills, cross-checks, writes meta + boot copy", async () => {
	const out = await buildPacket(
		{
			model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
			prefix: PREFIX,
			home: HOME,
		},
		fakeExec,
	);
	expect(out.meta.idsSha).toBe(SHA);
	expect(out.meta.tokenCount).toBe(42);
	expect(out.meta.kvBits).toBe(8);
	expect(out.meta.prefixSha).toBe(prefixSha(PREFIX));
	expect(out.meta.mlxLmVersion).toBe("0.31.3");
	expect((await Bun.file(out.paths.cache).arrayBuffer()).byteLength).toBe(2048);
	expect(await Bun.file(out.paths.boot).exists()).toBe(true);
	expect(await Bun.file(out.paths.meta).exists()).toBe(true);
});

test("buildPacket refuses render/prefill token disagreement", async () => {
	const liar: Exec = async (argv, _input) =>
		(argv[2] ?? "").includes("generate_step")
			? ok(
					`${JSON.stringify({ tokenCount: 42, idsSha: "b".repeat(64), cacheBytes: 1 })}\n`,
				)
			: ok(`${JSON.stringify({ tokenCount: 42, idsSha: SHA })}\n`);
	await expect(
		buildPacket(
			{
				model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
				prefix: PREFIX,
				home: HOME,
			},
			liar,
		),
	).rejects.toThrow("different tokens");
});

test("buildPacket surfaces python failure with the stderr tail", async () => {
	const dead: Exec = async () => ({
		exitCode: 1,
		stdout: "",
		stderr: "OSError: model dir missing",
	});
	await expect(
		buildPacket(
			{
				model: "mlx-community/Qwen3-4B-Instruct-2507-4bit",
				prefix: PREFIX,
				home: HOME,
			},
			dead,
		),
	).rejects.toThrow("kv render failed");
});

test("latestKvMeta picks the newest valid meta and ignores corrupt files", () => {
	const dir = join(HOME, "test_model");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "m1.json"),
		JSON.stringify(metaFor("a".repeat(64), "2026-01-01T00:00:00Z")),
	);
	writeFileSync(join(dir, "junk.json"), "{not json");
	writeFileSync(
		join(dir, "m2.json"),
		JSON.stringify(metaFor("b".repeat(64), "2026-02-01T00:00:00Z")),
	);
	const found = latestKvMeta("test/model", HOME);
	expect(found?.meta.idsSha).toBe("b".repeat(64));
	writeFileSync(
		join(dir, "m3.json"),
		JSON.stringify({
			...metaFor("c".repeat(64), "2026-03-01T00:00:00Z"),
			model: "other/model",
		}),
	);
	expect(latestKvMeta("test/model", HOME)?.meta.idsSha).toBe("b".repeat(64));
});

test("verifyPacket catches missing cache and size drift", () => {
	const sha = "d".repeat(64);
	const dir = join(HOME, "test_model");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "mv.json"),
		JSON.stringify(metaFor(sha, "2026-04-01T00:00:00Z")),
	);
	const cache = join(dir, `${sha}.safetensors`);
	writeFileSync(cache, Buffer.alloc(2048));
	expect(verifyPacket({ home: HOME }, "test/model").verdict).toBe("pass");
	writeFileSync(cache, Buffer.alloc(1024));
	expect(verifyPacket({ home: HOME }, "test/model").verdict).toBe("fail");
});

test("probeFromHelp parses the installed server's flag surface", () => {
	const withFlags = probeFromHelp(
		"--prompt-cache-file FILE   the cache\n  --kv-bits BITS  kv quantization",
		"0.31.3",
	);
	expect(withFlags.flags.promptCacheFile).toBe(true);
	expect(withFlags.flags.kvBits).toBe(true);
	const none = probeFromHelp("--port PORT\n--model MODEL", "0.31.3");
	expect(none.flags.promptCacheFile).toBe(false);
	expect(none.flags.kvBits).toBe(false);
});

test("serverKvArgs: boot copy + kv flags only when probe AND cache exist", () => {
	const sha = "e".repeat(64);
	const dir = join(HOME, "test_model");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "mf.json"),
		JSON.stringify(metaFor(sha, "2026-05-01T00:00:00Z")),
	);
	expect(serverKvArgs("test/model", HOME, null)).toEqual([]);
	const probe = {
		probedAt: "now",
		flags: { promptCacheFile: true, kvBits: true },
	};
	const args = serverKvArgs("test/model", HOME, probe);
	expect(args).toContain("--prompt-cache-file");
	expect(args).toContain(join(HOME, "test_model", `${sha}.boot.safetensors`));
	expect(args).toContain("--kv-bits");
	expect(serverKvArgs("unknown/model", HOME, probe)).toEqual([]);
});

test("probeServer writes the probe doc through the exec seam", async () => {
	const probePath = join(HOME, "probe.json");
	process.env.BELT_KV_PROBE = probePath;
	const probe = await probeServer(async () => ({
		exitCode: 0,
		stdout: "--prompt-cache-file x\n--kv-bits y",
		stderr: "",
	}));
	expect(probe.flags.promptCacheFile).toBe(true);
	expect(readProbe(probePath)?.flags.kvBits).toBe(true);
	delete process.env.BELT_KV_PROBE;
});

test("warmOpenaiBody: system-only by default, tools with withTools", () => {
	const a = warmOpenaiBody(PREFIX, 1, "m") as Record<string, unknown>;
	const b = warmOpenaiBody(PREFIX, 2, "m") as Record<string, unknown>;
	expect(a.max_tokens).toBe(1);
	expect(a.model).toBe("m");
	expect(a.tools).toBeUndefined();
	expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
	const msgs = a.messages as Array<{ role: string; content: string }>;
	expect(msgs[0].content).toBe("You are lane W240.\ntext two");
	const withTools = warmOpenaiBody(PREFIX, 3, "m", true) as Record<
		string,
		unknown
	>;
	expect(Array.isArray(withTools.tools)).toBe(true);
});

test("warmSpecialist passes against a live stub and fails when unreachable", async () => {
	const server = serveStub((_req, body) => {
		const parsed = (body ?? {}) as {
			messages: Array<{ content: string }>;
		};
		if (parsed.messages[1].content.startsWith("warm "))
			return Response.json({ usage: { prompt_tokens: 9000 } });
		return new Response("bad nonce", { status: 500 });
	});
	const r = await warmSpecialist({
		port: server.port,
		model: "m",
		prefix: PREFIX,
	});
	expect(r.verdict).toBe("pass");
	expect(r.promptTokens).toBe(9000);
	const bad = await warmSpecialist({
		port: 59999,
		model: "m",
		prefix: PREFIX,
		timeoutMs: 500,
	});
	expect(bad.verdict).toBe("fail");
	server.close();
});

test("warmAll skips ports outside the registry without touching the network", async () => {
	const results = await warmAll({ prefix: PREFIX, ports: [8999] }, async () => {
		throw new Error("network must not be touched");
	});
	expect(results[0].verdict).toBe("skipped");
	expect(results[0].why).toBe("not in registry");
});
