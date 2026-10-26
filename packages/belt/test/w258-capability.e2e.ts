// test/w258-capability.test.ts — W258: per-machine capability auto-assessment.
// parseModelSignature/depthTier + the magnitude bands are pure grammar/math —
// tested against the registry's real model ids and the benchmark anchors.
// capabilityRows takes injection params so in-process tests never need the
// runtime config; the CLI is proven with a scratch-HOME spawn (W224 idiom).
import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assessRemoteEndpoint,
	CAPABILITY_DOCTRINE,
	depthTier,
	parseModelSignature,
} from "../bin/catalog-capability.ts";
import type { RemoteEndpoint, RemoteMachine } from "../bin/remotes.ts";

const sig = (id: string) => parseModelSignature(id);

test.describe("parseModelSignature (W258)", () => {
	test("registry MoE id parses total/active/quant/purposes @unit", () => {
		const s = sig("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit");
		expect(s.paramsB).toBe(30);
		expect(s.activeB).toBe(3);
		expect(s.quant).toBe("4bit");
		expect(s.purposes).toContain("code");
		expect(s.purposes).toContain("instruct");
	});

	test("dense 4B id has no active slice @unit", () => {
		const s = sig("mlx-community/Qwen3-4B-Instruct-2507-4bit");
		expect(s.paramsB).toBe(4);
		expect(s.activeB).toBeNull();
		expect(s.quant).toBe("4bit");
	});

	test("ollama id carries params after the colon @unit", () => {
		expect(sig("qwen2.5:0.5b").paramsB).toBe(0.5);
	});

	test("glm-5.3: no size marker degrades to nulls + general @unit", () => {
		const s = sig("glm-5.3");
		expect(s.paramsB).toBeNull();
		expect(s.activeB).toBeNull();
		expect(s.quant).toBeNull();
		expect(s.purposes).toEqual(["general"]);
	});

	test("hostile ids degrade to nulls, never throw @unit", () => {
		for (const id of ["", "x\ny", "!!!", "123", "-"]) {
			expect(sig(id).paramsB).toBeNull();
		}
	});
});

test.describe("depth tiers (W258)", () => {
	test("dense 4B extract: menial @unit", () => {
		const s = sig("mlx-community/Qwen3-4B-Instruct-2507-4bit");
		expect(depthTier(s, false, "extract")).toBe("menial");
	});
	test("MoE 30B-A3B coder: heavy (never the dense band) @unit", () => {
		const s = sig("mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit");
		expect(depthTier(s, false, "code")).toBe("heavy");
	});
	test("35B-A3B reasoner: heavy, not frontier @unit", () => {
		expect(
			depthTier(
				sig("mlx-community/Qwen3.5-35B-A3B-OptiQ-4bit"),
				false,
				"reason",
			),
		).toBe("heavy");
	});
	test("cloud model without size marker: frontier by policy @unit", () => {
		expect(depthTier(sig("glm-5.3"), true)).toBe("frontier");
	});
	test("rank-only roles force special regardless of id grammar @unit", () => {
		expect(depthTier(sig("jaredpalmer/kev-4b"), false, "classify")).toBe(
			"special",
		);
		expect(depthTier(sig("some-model-7b"), false, "rerank")).toBe("special");
	});
	test("unknown-size LAN model stays unknown @unit", () => {
		expect(depthTier(sig("mystery-model"), false)).toBe("unknown");
	});
});

test.describe("band arithmetic via assessRemoteEndpoint (W258)", () => {
	const machine = (cloud = false): RemoteMachine => ({
		name: "w258box",
		host: "box.invalid",
		ip_fallback: "127.0.0.1",
		...(cloud ? { cloud: true } : {}),
		endpoints: [],
	});
	const ep = (
		model: string | undefined,
		roles = ["general"],
	): RemoteEndpoint => ({
		port: 1234,
		protocol: "openai",
		roles,
		...(model !== undefined ? { model } : {}),
	});

	test("remote LAN halves the floor (conservative) @unit", () => {
		const row = assessRemoteEndpoint(machine(), ep("qwen2.5:0.5b"));
		expect(row.kind).toBe("remote");
		expect(row.speed_range).toEqual([40, 250]);
		expect(row.speed_basis).toBe("conservative");
		expect(row.confidence).toBe("low");
	});

	test("cloud rows: no single-machine tok/s claim @unit", () => {
		const row = assessRemoteEndpoint(machine(true), ep("glm-5.3", ["complex"]));
		expect(row.kind).toBe("cloud");
		expect(row.speed_range).toBeNull();
		expect(row.speed_basis).toBe("none");
		expect(row.depth).toBe("frontier");
	});

	test("model-less endpoint degrades to a roles descriptor @unit", () => {
		const row = assessRemoteEndpoint(
			machine(),
			ep(undefined, ["ocr", "embed"]),
		);
		expect(row.model.startsWith("(roles:")).toBe(true);
		expect(row.depth).toBe("special");
	});

	test("special-role endpoints carry no chat band @unit", () => {
		const row = assessRemoteEndpoint(machine(), ep("some-embed-7b", ["embed"]));
		expect(row.speed_range).toBeNull();
		expect(row.depth).toBe("special");
	});
});

test.describe("CLI + markdown (W258)", () => {
	const HOME = mkdtempSync(join(tmpdir(), "belt-w258-"));
	test.afterAll(() => rmSync(HOME, { recursive: true, force: true }));

	test("--json payload: registry rows, doctrine, range invariants @unit", () => {
		const proc = Bun.spawnSync(["bun", "bin/catalog-capability.ts", "--json"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, HOME },
		});
		expect(proc.exitCode).toBe(0);
		const payload = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
			doctrine: string[];
			rows: { speed_range: [number, number] | null }[];
		};
		expect(payload.doctrine.length).toBe(CAPABILITY_DOCTRINE.length);
		expect(payload.rows.length).toBeGreaterThanOrEqual(7);
		for (const r of payload.rows) {
			if (r.speed_range !== null) {
				expect(r.speed_range[0]).toBeGreaterThan(0);
				expect(r.speed_range[0]).toBeLessThanOrEqual(r.speed_range[1]);
			}
		}
	});
});

test.describe("markdown view (W258)", () => {
	const HOME = mkdtempSync(join(tmpdir(), "belt-w258-md-"));
	test.afterAll(() => rmSync(HOME, { recursive: true, force: true }));

	test("markdown names the forecast, machines, conservative floor @unit", () => {
		const proc = Bun.spawnSync(["bun", "bin/catalog-capability.ts"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, HOME },
		});
		const md = new TextDecoder().decode(proc.stdout);
		expect(proc.exitCode).toBe(0);
		expect(md).toContain("Fleet capability forecast");
		expect(md).toContain("conservative");
		expect(md).toContain("## ");
	});
});
