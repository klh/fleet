// W1124.8.4 — provider-profile contract parity: belt's npm-free twin
// (bin/provider-profiles.ts, Bun.YAML) and the speedy central resolver
// (speedy/src/provider-config.ts, `yaml` npm) MUST answer identically on
// the same fixtures, or a gateway row and the hub delivery leg drift.
// Fixture key material is fake; fixtures are real mode-600 files.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadProviderProfiles,
	profileForEndpoint,
	profileForEnv,
	validateProviderProfiles,
} from "../bin/provider-profiles.ts";
import {
	loadProviderConfig,
	profileForEndpoint as speedyEndpoint,
	profileForEnv as speedyEnv,
	validateProviderConfig,
} from "../../speedy/src/provider-config.ts";

let dir = "";
let stackPath = "";

const writeStack = (body: string, mode = 0o600): void => {
	writeFileSync(stackPath, body);
	chmodSync(stackPath, mode);
};

beforeAll(() => {
	dir = join(tmpdir(), `provider-parity-${process.pid}`);
	mkdirSync(dir, { recursive: true });
	stackPath = join(dir, "stack.yaml");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CODED = `providers:
  zai-coding:
    provider: zai
    key: fake-zai-key
    env: Z_AI_API_KEY
    endpoints:
      anthropic: https://api.z.ai/api/anthropic
  zai-general:
    provider: zai
    key: fake-general-key
    env: Z_AI_GENERAL_API_KEY
    endpoints:
      anthropic: https://general.z.ai/api/anthropic
`;

describe("provider-profile parity (belt twin ↔ speedy resolver)", () => {
	test("identical typed profiles from the same stack", () => {
		writeStack(CODED);
		expect(loadProviderProfiles(stackPath)).toEqual(
			loadProviderConfig(stackPath),
		);
	});

	test("profileForEnv resolves the same binding in both", () => {
		const belt = loadProviderProfiles(stackPath);
		const speedy = loadProviderConfig(stackPath);
		expect(profileForEnv("Z_AI_API_KEY", belt)?.name).toBe("zai-coding");
		expect(speedyEnv("Z_AI_API_KEY", speedy)?.name).toBe("zai-coding");
		expect(profileForEnv("Z_AI_GENERAL_API_KEY", belt)?.key).toBe(
			speedyEnv("Z_AI_GENERAL_API_KEY", speedy)?.key,
		);
		expect(profileForEnv("NOPE_KEY", belt)).toBeNull();
		expect(speedyEnv("NOPE_KEY", speedy)).toBeNull();
	});

	test("endpoint match picks zai-coding, never the sibling zai profile", () => {
		const belt = loadProviderProfiles(stackPath);
		const speedy = loadProviderConfig(stackPath);
		for (const match of [
			profileForEndpoint("anthropic", "https://api.z.ai/api/anthropic", belt),
			speedyEndpoint("anthropic", "https://api.z.ai/api/anthropic", speedy),
		]) {
			expect(match?.name).toBe("zai-coding");
			expect(match?.env).toBe("Z_AI_API_KEY");
		}
		expect(
			profileForEndpoint(
				"anthropic",
				"https://general.z.ai/api/anthropic",
				belt,
			)?.name,
		).toBe("zai-general");
		expect(
			profileForEndpoint("anthropic", "https://other.example", belt),
		).toBeNull();
	});

	test("legacy declarations and env collisions reject identically", () => {
		for (const [load, validate] of [
			[loadProviderProfiles, validateProviderProfiles],
			[loadProviderConfig, validateProviderConfig],
		] as const) {
			writeStack(
				"providers:\n  x:\n    provider: zai\n    key: k\n    key_file: /old/path\n",
			);
			expect(() => load(stackPath)).toThrow("legacy key_file");
			expect(() =>
				validate({
					a: { provider: "zai", key: "k", env: "E1" },
					b: { provider: "zai", key: "k2", env: "E1" },
				}),
			).toThrow("both bind env E1");
		}
	});

	test("file posture enforced identically (mode, absence)", () => {
		writeStack(CODED, 0o644);
		expect(() => loadProviderProfiles(stackPath)).toThrow("mode 600");
		expect(() => loadProviderConfig(stackPath)).toThrow("mode 600");
		expect(() => loadProviderProfiles(join(dir, "absent.yaml"))).toThrow(
			"not readable",
		);
		expect(() => loadProviderConfig(join(dir, "absent.yaml"))).toThrow(
			"not readable",
		);
		writeStack(CODED);
	});

	test("errors stay redacted — no fixture key material in any message", () => {
		writeStack("providers:\n  x: []\n");
		for (const attempt of [
			() => loadProviderProfiles(stackPath),
			() => loadProviderConfig(stackPath),
		]) {
			try {
				attempt();
			} catch (error) {
				const message = String(error);
				expect(message).toContain("profile x");
				expect(message).not.toContain("fake-zai");
			}
		}
		writeStack(CODED);
	});
});
