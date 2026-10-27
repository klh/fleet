// W280 — client adoption of the direct-tier resolver: the emitted
// direct-tiers.json artifact is the TS resolution source (after the operator
// pin), and direct-client.ts is the one-call client library (registry model
// id, client-side budget policy, gateway fallback, kill switch). No sockets —
// fetcher-injected; no machine files — home-injected.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	directModelId,
	directChat,
	loadGatewayKey,
} from "../bin/direct-client.ts";
import {
	loadDirectTiers,
	readDirectTiersArtifact,
	resolveTarget,
} from "../bin/router-policy.ts";

// temp HOME root: .claude/local-llm/direct-tiers.json inside it
const tempHome = (): string => mkdtempSync(join(tmpdir(), "dt-home-"));

const writeArtifact = (home: string, body: string): string => {
	const path = join(home, ".claude/local-llm/direct-tiers.json");
	mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
	writeFileSync(path, body);
	return path;
};

test.describe("direct-tier artifact resolution (W280)", () => {
	test("artifact rows normalize to /v1 and feed resolveTarget @unit", () => {
		const home = tempHome();
		try {
			writeArtifact(
				home,
				JSON.stringify({ "local-extract": "http://127.0.0.1:8902" }),
			);
			const tiers = loadDirectTiers(undefined, home);
			expect(tiers).toEqual({ "local-extract": "http://127.0.0.1:8902/v1" });
			const t = resolveTarget("local-extract", "http://127.0.0.1:4100", tiers);
			expect(t.direct).toBe(true);
			expect(t.base).toBe("http://127.0.0.1:8902/v1");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("corrupt/empty artifacts yield null so the YAML chain answers @unit", () => {
		const home = tempHome();
		try {
			const path = writeArtifact(home, "[1,2]");
			expect(readDirectTiersArtifact(path)).toBeNull();
			writeArtifact(home, "{}");
			expect(readDirectTiersArtifact(path)).toBeNull();
			writeArtifact(home, "not json");
			expect(readDirectTiersArtifact(path)).toBeNull();
			writeArtifact(home, '"scalar"');
			expect(readDirectTiersArtifact(path)).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("grammar-failing rows are skipped, valid rows survive @unit", () => {
		const home = tempHome();
		try {
			const path = writeArtifact(
				home,
				JSON.stringify({
					"local-coder": "http://127.0.0.1:8901",
					bad: "https://evil.example/v1",
				}),
			);
			expect(readDirectTiersArtifact(path)).toEqual({
				"local-coder": "http://127.0.0.1:8901/v1",
			});
			const tiers = loadDirectTiers(undefined, home);
			expect(tiers).toEqual({ "local-coder": "http://127.0.0.1:8901/v1" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

// ─── the one-call client library ───
test.describe("directChat (W280)", () => {
	const okRes = (): Response =>
		Response.json({ choices: [{ message: { content: "pong" } }] });

	const recorder = (plan: (url: string) => Response) => {
		const calls: { url: string; model: string; auth: string | null }[] = [];
		const fetcher: typeof fetch = async (input, init) => {
			const b = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
			const url = String(input);
			calls.push({
				url,
				model: b.model ?? "",
				auth:
					(init?.headers as Record<string, string> | undefined)
						?.authorization ?? null,
			});
			return plan(url);
		};
		return { calls, fetcher };
	};

	test("direct leg sends the registry model id, unauthenticated @unit", async () => {
		const { calls, fetcher } = recorder(() => okRes());
		const r = await directChat({
			model: "local-extract",
			messages: [{ role: "user", content: "hi" }],
			maxTokens: 500,
			direct: { "local-extract": "http://127.0.0.1:8902/v1" },
			fetcher,
			env: { HOME: "/tmp/dt-unused" },
			logPath: "/dev/null",
		});
		expect(r.via).toBe("direct");
		expect(r.wireModel).toBe(directModelId("local-extract"));
		expect(r.reply).toBe("pong");
		expect(r.note).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:8902/v1/chat/completions");
		expect(calls[0]?.model).toBe(directModelId("local-extract"));
		expect(calls[0]?.auth).toBeNull();
	});

	test("gateway leg sends the alias with the master key @unit", async () => {
		const { calls, fetcher } = recorder(() => okRes());
		const r = await directChat({
			model: "glm-5.3-flash",
			messages: [{ role: "user", content: "hi" }],
			gatewayBase: "http://127.0.0.1:4100",
			direct: {},
			fetcher,
			env: { LITELLM_KEY: "k-test", HOME: "/tmp/dt-unused" },
			logPath: "/dev/null",
		});
		expect(r.via).toBe("gateway");
		expect(r.wireModel).toBe("glm-5.3-flash");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:4100/v1/chat/completions");
		expect(calls[0]?.auth).toBe("Bearer k-test");
	});

	test("kill switch BELT_DIRECT_TIERS=0 forces the gateway @unit", async () => {
		const { calls, fetcher } = recorder(() => okRes());
		const r = await directChat({
			model: "local-extract",
			messages: [{ role: "user", content: "hi" }],
			direct: { "local-extract": "http://127.0.0.1:8902/v1" },
			fetcher,
			env: {
				BELT_DIRECT_TIERS: "0",
				LITELLM_KEY: "k-test",
				HOME: "/tmp/dt-unused",
			},
			logPath: "/dev/null",
		});
		expect(r.via).toBe("gateway");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:4100/v1/chat/completions");
	});

	test("direct 404 retries once through the gateway @unit", async () => {
		const { calls, fetcher } = recorder((url) =>
			url.includes(":8902") ? new Response("nope", { status: 404 }) : okRes(),
		);
		const r = await directChat({
			model: "local-extract",
			messages: [{ role: "user", content: "hi" }],
			direct: { "local-extract": "http://127.0.0.1:8902/v1" },
			fetcher,
			env: { LITELLM_KEY: "k-test", HOME: "/tmp/dt-unused" },
			logPath: "/dev/null",
		});
		expect(r.via).toBe("gateway");
		expect(r.note).toContain("404");
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toContain(":8902");
		expect(calls[1]?.url).toContain(":4100");
		expect(calls[1]?.model).toBe("local-extract");
	});

	test("loadGatewayKey: env wins, file fallback, honest error @unit", () => {
		const dir = mkdtempSync(join(tmpdir(), "dt-key-"));
		try {
			const keyPath = join(dir, ".claude/local-llm/litellm.key");
			mkdirSync(join(dir, ".claude/local-llm"), { recursive: true });
			writeFileSync(keyPath, "k-file\n");
			expect(loadGatewayKey({ HOME: dir })).toBe("k-file");
			expect(loadGatewayKey({ HOME: dir, LITELLM_KEY: "k-env" })).toBe("k-env");
			let threw = "";
			try {
				loadGatewayKey({ HOME: "/tmp/dt-missing-home" });
			} catch (e) {
				threw = e instanceof Error ? e.message : String(e);
			}
			expect(threw).toContain("direct-client");
			expect(threw).toContain("LITELLM_KEY env or");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
