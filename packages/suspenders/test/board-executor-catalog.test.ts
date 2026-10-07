// test/board-executor-catalog.test.ts — W224: the board half of the
// executor/model catalog. Pure unit tests over executor-catalog.ts —
// deliberately db-free (the module imports belt.ts types only), so the
// test process never opens governor.db.
import { describe, expect, test } from "bun:test";
import type { BeltEndpoint } from "../hooks/board/belt.ts";
import {
	buildBeltEntries,
	feedModelOf,
	resolveLlmTarget,
} from "../hooks/board/executor-catalog.ts";

const row = (over: Partial<BeltEndpoint>): BeltEndpoint => ({
	machine: "nas",
	port: 9100,
	protocol: "openai",
	model: "qwen-default",
	ok: true,
	roles: ["general"],
	host: "nas.local",
	ip: "192.168.1.73",
	...over,
});

describe("W224 executor catalog (board half)", () => {
	test("default entry keeps the W105 shape; catalog ids become picks", () => {
		const entries = buildBeltEntries(
			[row({ models: ["qwen-default", "qwen2.5:0.5b", "m-b"] })],
			new Set(),
		);
		expect(entries[0]).toEqual({
			value: "llm:nas:qwen-default",
			label: "nas · qwen-default (local)",
			model: "qwen-default",
			locality: "local",
			plane: "remote",
			reasoningEffort: false,
		});
		expect(entries.slice(1).map((e) => e.value)).toEqual([
			"llm:nas:qwen2.5:0.5b",
			"llm:nas:m-b",
		]);
		expect(entries[1]?.label).toBe("nas · qwen2.5:0.5b (local)");
	});

	test("catalog picks: no default dup, (down) carried, hub plane per model", () => {
		const entries = buildBeltEntries(
			[
				row({ ok: false, models: ["qwen-default", "m-x"] }),
				row({
					machine: "zai",
					host: "api.z.ai",
					ip: undefined,
					models: ["glm-x"],
				}),
			],
			new Set(["m-x", "glm-x"]),
		);
		const vals = entries.map((e) => e.value);
		// default model appears once, not twice
		expect(vals.filter((v) => v === "llm:nas:qwen-default").length).toBe(1);
		// dead endpoint keeps its catalog picks, labeled (down)
		const down = entries.find((e) => e.value === "llm:nas:m-x");
		expect(down?.label).toContain("(down)");
		// hub entitlement is per model id, label prefixed
		const hub = entries.find((e) => e.value === "llm:zai:glm-x");
		expect(hub?.plane).toBe("hub");
		expect(hub?.label.startsWith("[HUB] zai · glm-x")).toBe(true);
		expect(hub?.locality).toBe("remote");
	});

	test("old belt rows (no models field) degrade to the single default entry", () => {
		expect(buildBeltEntries([row({})], new Set()).length).toBe(1);
		expect(
			buildBeltEntries(
				[row({ protocol: "llama", models: ["m-llama"] })],
				new Set(),
			).length,
		).toBe(0); // non-openai rows stay out of the feed
	});
});

describe("W224 resolveLlmTarget", () => {
	const rows = [
		row({ models: ["qwen-default", "qwen2.5:0.5b"] }),
		row({
			machine: "zai",
			host: "api.z.ai",
			ip: undefined,
			model: "glm-5.3-flash",
		}),
	];

	test("port tail and default-model tail match the row directly", () => {
		expect(resolveLlmTarget(rows, "nas", "9100")).toEqual({
			ep: rows[0],
			override: undefined,
		});
		expect(resolveLlmTarget(rows, "nas", "qwen-default")?.override).toBe(
			"qwen-default",
		);
	});

	test("catalog id falls back to machine-level targeting with override", () => {
		const hit = resolveLlmTarget(rows, "nas", "qwen2.5:0.5b");
		expect(hit?.ep.port).toBe(9100);
		expect(hit?.override).toBe("qwen2.5:0.5b");
		// cross-machine isolation: nas catalog ids never resolve on zai
		expect(resolveLlmTarget(rows, "zai", "qwen2.5:0.5b")).toBeNull();
	});

	test("garbage tails and unknown machines stay null (409 upstream)", () => {
		expect(resolveLlmTarget(rows, "nas", "garbage-id")).toBeNull();
		expect(resolveLlmTarget(rows, "nope", "9100")).toBeNull();
		expect(resolveLlmTarget([], "nas", "9100")).toBeNull();
	});
});

describe("W183.2 feed-value translation (chain slots)", () => {
	const specByPort = (p: number) =>
		p === 8901 ? { model: "qwen3-coder" } : undefined;
	const userByName = (n: string) =>
		n === "mistral" ? { model: "mistral-7b" } : undefined;

	test("bare names: claude/copilot → null (own CLI), other names are model ids", () => {
		expect(feedModelOf("claude", specByPort, userByName)).toBeNull();
		expect(feedModelOf("copilot", specByPort, userByName)).toBeNull();
		expect(feedModelOf("glm-5.3-flash", specByPort, userByName)).toBe(
			"glm-5.3-flash",
		);
	});

	test("llm:local:<port> via the swarm inventory; unknown port → null", () => {
		expect(feedModelOf("llm:local:8901", specByPort, userByName)).toBe(
			"qwen3-coder",
		);
		expect(feedModelOf("llm:local:9999", specByPort, userByName)).toBeNull();
	});

	test("llm:user:<name> via local-models.json; unknown → null", () => {
		expect(feedModelOf("llm:user:mistral", specByPort, userByName)).toBe(
			"mistral-7b",
		);
		expect(feedModelOf("llm:user:ghost", specByPort, userByName)).toBeNull();
	});

	test("machine tail IS the belt model id; malformed shapes → null", () => {
		expect(feedModelOf("llm:desktop:glm-x", specByPort, userByName)).toBe(
			"glm-x",
		);
		expect(feedModelOf("llm:desktop:", specByPort, userByName)).toBeNull();
		expect(feedModelOf("llm:nocolon", specByPort, userByName)).toBeNull();
	});
});
