// test/buckle-route.test.ts — W1265 suspenders-side route-config adapter:
// face mapping over the W298 catalog, base-URL grammar, the owner table,
// and the claude-code/codex writers against a pinned temp HOME (no env
// writes — HOME stays the caller's; the writers take home explicitly).
import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyBuckleRoute,
	buckleBaseURL,
	planBuckleRoutes,
	renderBuckleRouteTable,
} from "../hooks/lib/hub/buckle-route.ts";

const home = (): string => mkdtempSync(join(tmpdir(), "w1265-route-"));

test.describe("W1265 base URL grammar", () => {
	test("lane + provider + wire; codex faces end /v1", () => {
		expect(buckleBaseURL("http://f:4101/", "anthropic", {})).toBe(
			"http://f:4101/anthropic",
		);
		expect(
			buckleBaseURL("http://f:4101", "openai", { lane: "l7", provider: "zai" }),
		).toBe("http://f:4101/w/l7/zai/openai");
		expect(
			buckleBaseURL("http://f:4101", "openai", {
				lane: "l7",
				provider: "zai",
				endsInV1: true,
			}),
		).toBe("http://f:4101/w/l7/zai/openai/v1");
	});
});

test.describe("W1265 plans + table", () => {
	test("three catalog faces plan; no-face agents skip", () => {
		const plans = planBuckleRoutes({
			agents: ["claude-code", "codex", "grok", "aider"],
			front: "http://f:4101",
			lane: "l7",
			provider: "zai",
			home: "/tmp/h",
		});
		expect(plans.map((p) => p.agent)).toEqual(["claude-code", "codex", "grok"]);
		expect(plans[0]?.base).toBe("http://f:4101/w/l7/zai/anthropic");
		expect(plans[1]?.base).toBe("http://f:4101/w/l7/zai/openai/v1");
		expect(plans.every((p) => p.model === "glm-5.3")).toBe(true);
		const table = renderBuckleRouteTable(plans);
		for (const col of [
			"TOOL",
			"CONFIG FILE",
			"BASE URL",
			"WIRE",
			"PROVIDER",
			"MODEL",
			"DISABLE ACTION",
		])
			expect(table).toContain(col);
		expect(table).toContain(".claude/settings.json");
		expect(table).toContain("model_providers.buckle");
	});
});

test.describe("W1265 claude-code writer", () => {
	test("merges env.ANTHROPIC_BASE_URL preserving existing settings", () => {
		const h = home();
		mkdirSync(join(h, ".claude"), { recursive: true });
		const settingsPath = join(h, ".claude", "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ model: "opus", env: { FOO: "1" } }),
		);
		const [plan] = planBuckleRoutes({
			agents: ["claude-code"],
			front: "http://f:4101",
			lane: "l7",
			provider: "zai",
			home: h,
		});
		if (plan === undefined) return;
		const res = applyBuckleRoute(plan);
		expect(res.ok).toBe(true);
		const doc = JSON.parse(readFileSync(settingsPath, "utf8")) as {
			model?: string;
			env?: Record<string, string>;
		};
		expect(doc.env?.ANTHROPIC_BASE_URL).toBe(
			"http://f:4101/w/l7/zai/anthropic",
		);
		expect(doc.env?.FOO).toBe("1");
		expect(doc.model).toBe("opus");
	});
});

test.describe("W1265 claude writer refusal", () => {
	test("unparseable settings.json refuses, file untouched", () => {
		const h = home();
		mkdirSync(join(h, ".claude"), { recursive: true });
		const settingsPath = join(h, ".claude", "settings.json");
		writeFileSync(settingsPath, "{not json");
		const [plan] = planBuckleRoutes({
			agents: ["claude-code"],
			front: "http://f:4101",
			home: h,
		});
		if (plan === undefined) return;
		const res = applyBuckleRoute(plan);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.why).toContain("unparseable");
		expect(readFileSync(settingsPath, "utf8")).toBe("{not json");
	});
});

test.describe("W1265 codex writer", () => {
	test("splices [model_providers.buckle] fresh, then idempotent re-run", () => {
		const h = home();
		const [plan] = planBuckleRoutes({
			agents: ["codex"],
			front: "http://f:4101",
			lane: "l7",
			provider: "zai",
			home: h,
		});
		if (plan === undefined) return;
		const r1 = applyBuckleRoute(plan);
		expect(r1.ok).toBe(true);
		const cfg = join(h, ".codex", "config.toml");
		let text = readFileSync(cfg, "utf8");
		expect(text).toContain('model_provider = "buckle"');
		expect(text).toContain("[model_providers.buckle]");
		expect(text).toContain('base_url = "http://f:4101/w/l7/zai/openai/v1"');
		expect(text).toContain('wire_api = "responses"');
		expect(
			text.indexOf('model_provider = "buckle"') <
				text.indexOf("[model_providers.buckle]"),
		).toBe(true);
		const r2 = applyBuckleRoute(plan);
		expect(r2.ok).toBe(true);
		text = readFileSync(cfg, "utf8");
		expect(text.split("[model_providers.buckle]").length - 1).toBe(1);
	});
});

test.describe("W1265 codex writer conflicts", () => {
	test("conflicting model_provider refuses without writing", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const cfg = join(h, ".codex", "config.toml");
		writeFileSync(cfg, 'model_provider = "openai"\n');
		const [plan] = planBuckleRoutes({
			agents: ["codex"],
			front: "http://f:4101",
			home: h,
		});
		if (plan === undefined) return;
		const res = applyBuckleRoute(plan);
		expect(res.ok).toBe(false);
		if (res.ok) return;
		expect(res.why).toContain('model_provider already "openai"');
		expect(readFileSync(cfg, "utf8")).toBe('model_provider = "openai"\n');
	});
});

test.describe("W1265 codex table-only config", () => {
	test("model_provider lands before the first existing table", () => {
		const h = home();
		mkdirSync(join(h, ".codex"), { recursive: true });
		const cfg = join(h, ".codex", "config.toml");
		writeFileSync(cfg, "[profile]\nfoo = 1\n");
		const [plan] = planBuckleRoutes({
			agents: ["codex"],
			front: "http://f:4101",
			home: h,
		});
		if (plan === undefined) return;
		const res = applyBuckleRoute(plan);
		expect(res.ok).toBe(true);
		const text = readFileSync(cfg, "utf8");
		expect(
			text.indexOf('model_provider = "buckle"') < text.indexOf("[profile]"),
		).toBe(true);
		expect(text).toContain("[model_providers.buckle]");
	});
});

test.describe("W1265 manual face", () => {
	test("grok plans a manual row and never writes", () => {
		const h = home();
		const [plan] = planBuckleRoutes({
			agents: ["grok"],
			front: "http://f:4101",
			home: h,
		});
		if (plan === undefined) return;
		const res = applyBuckleRoute(plan);
		expect(res.ok).toBe(false);
		expect(existsSync(join(h, ".grok"))).toBe(false);
	});
});
