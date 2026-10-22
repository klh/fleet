// W1124.8.1 — the central provider schema + resolver. Fixtures write a real
// private stack.yaml (mode 600) and read it back through the public API —
// file-posture enforcement included. Key material in fixtures is fake.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	loadProviderConfig,
	PROVIDER_STACK_PATH,
	resolveProvider,
	validateProviderConfig,
	type ProviderEntry,
} from "../src/provider-config.ts";

let home = "";
let stackPath = "";

const writeStack = (body: string, mode = 0o600): void => {
	writeFileSync(stackPath, body);
	chmodSync(stackPath, mode);
};

beforeAll(() => {
	home = join(import.meta.dir, `.fixture-home-${process.pid}`);
	mkdirSync(home, { recursive: true });
	stackPath = join(home, "stack.yaml");
	process.env.KLH_STACK = stackPath;
});

afterAll(() => {
	delete process.env.KLH_STACK;
	rmSync(home, { recursive: true, force: true });
});

describe("loadProviderConfig", () => {
	test("reads mode-600 stack, returns typed profiles", () => {
		writeStack(
			[
				"providers:",
				"  zai-coding:",
				"    provider: zai",
				"    key: fake-key-coding",
				"    env: ZAI_CODING_API_KEY",
				"    endpoints:",
				"      openai: https://api.example/v1",
				"      anthropic: https://api.example/anthropic",
				"  zai-general:",
				"    provider: zai",
				"    key: fake-key-general",
				"  anthropic:",
				"    provider: anthropic",
				"    key: fake-key-anthropic",
				"    env: ANTHROPIC_API_KEY",
				"    endpoints:",
				"      catalog: https://example/catalog.json",
			].join("\n"),
		);
		const cfg = loadProviderConfig();
		expect(Object.keys(cfg).sort()).toEqual([
			"anthropic",
			"zai-coding",
			"zai-general",
		]);
		expect(cfg["zai-coding"].key).toBe("fake-key-coding");
		expect(cfg["zai-coding"].env).toBe("ZAI_CODING_API_KEY");
		expect(cfg["zai-coding"].endpoints?.openai).toBe("https://api.example/v1");
	});

	test("stack without providers section = valid empty config", () => {
		writeStack("hubs: {}\nversion: test-pin\n");
		expect(loadProviderConfig()).toEqual({});
	});

	test("missing file throws with the path, never values", () => {
		expect(() => loadProviderConfig(join(home, "absent.yaml"))).toThrow(
			/not readable/,
		);
	});

	test("loose file mode refused (posture is part of the schema)", () => {
		writeStack("providers: {}\n", 0o644);
		expect(() => loadProviderConfig()).toThrow(/mode 600/);
	});

	test("non-YAML body throws, path only in the message", () => {
		writeStack("\t::: not yaml [[[\n");
		expect(() => loadProviderConfig()).toThrow(/not parseable YAML/);
	});

	test("PROVIDER_STACK_PATH honors KLH_STACK", () => {
		expect(PROVIDER_STACK_PATH()).toBe(stackPath);
	});
});

describe("validateProviderConfig (pure, parsed slice)", () => {
	test("undefined/null = {}", () => {
		expect(validateProviderConfig(undefined)).toEqual({});
		expect(validateProviderConfig(null)).toEqual({});
	});

	test("non-map slice throws", () => {
		expect(() => validateProviderConfig(["x"])).toThrow(/map of named/);
	});

	test("profile must be a mapping with provider + non-empty key", () => {
		expect(() => validateProviderConfig({ p: "string" })).toThrow(
			/profile p must be a mapping/,
		);
		expect(() => validateProviderConfig({ p: { provider: "zai" } })).toThrow(
			/profile p: key/,
		);
		expect(() =>
			validateProviderConfig({ p: { provider: "", key: "k" } }),
		).toThrow(/provider family is required/);
	});

	test("env must be an env-var NAME", () => {
		const bad: Record<string, unknown> = {
			p: { provider: "zai", key: "k", env: "not a name" },
		};
		expect(() => validateProviderConfig(bad)).toThrow(/env var NAME/);
	});

	test("endpoints must be http(s) URLs", () => {
		const bad: Record<string, unknown> = {
			p: {
				provider: "zai",
				key: "k",
				endpoints: { openai: "ftp://x" },
			},
		};
		expect(() => validateProviderConfig(bad)).toThrow(
			/endpoints.openai must be an http\(s\) URL/,
		);
	});

	test("duplicate env bindings across profiles throw", () => {
		const dup: Record<string, unknown> = {
			a: { provider: "zai", key: "k1", env: "ZAI_KEY" },
			b: { provider: "zai", key: "k2", env: "ZAI_KEY" },
		};
		expect(() => validateProviderConfig(dup)).toThrow(/both bind env/);
	});

	test("unknown endpoint fields are dropped, known ones kept", () => {
		const cfg = validateProviderConfig({
			p: {
				provider: "zai",
				key: "k",
				endpoints: { openai: "https://ok", rogue: "https://x" },
			},
		});
		expect(cfg.p.endpoints).toEqual({ openai: "https://ok" });
	});

	test("error messages never carry key material", () => {
		try {
			validateProviderConfig({ p: { provider: "zai", key: "" } });
			expect.unreachable();
		} catch (e) {
			const msg = String((e as Error).message);
			expect(msg).not.toContain("fake");
			expect(msg).toContain("profile p");
		}
	});
});

describe("resolveProvider", () => {
	const providers: Record<string, ProviderEntry> = {
		"zai-coding": {
			provider: "zai",
			key: "fake-key-coding",
			env: "ZAI_CODING_API_KEY",
			endpoints: { openai: "https://api.example/v1" },
		},
		"zai-general": { provider: "zai", key: "fake-key-general" },
	};

	test("absent optional profile → null", () => {
		expect(resolveProvider("nope", providers)).toBeNull();
	});

	test("resolved profile carries name/provider/key/env/endpoints", () => {
		const r = resolveProvider("zai-coding", providers);
		expect(r).not.toBeNull();
		expect(r?.name).toBe("zai-coding");
		expect(r?.provider).toBe("zai");
		expect(r?.key).toBe("fake-key-coding");
		expect(r?.env).toBe("ZAI_CODING_API_KEY");
		expect(r?.endpoints).toEqual({ openai: "https://api.example/v1" });
	});

	test("profile without env resolves env=null, endpoints={}", () => {
		const r = resolveProvider("zai-general", providers);
		expect(r?.env).toBeNull();
		expect(r?.endpoints).toEqual({});
	});

	test("invalid CONFIGURED profile throws (redacted)", () => {
		expect(() =>
			resolveProvider("broken", {
				broken: { provider: "zai", key: "" },
			}),
		).toThrow(/profile broken: key/);
	});
});
