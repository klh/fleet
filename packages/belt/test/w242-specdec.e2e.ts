// test/w242-specdec.test.ts — W242: speculative decoding as a catalog
// dimension. Pure helpers proven on fixtures (no network): class-token
// parsing survives quant suffixes, snapshot detection reads index json and
// raw safetensors headers, verdict gates (phantom, 30B-class, tried-memo),
// slot suggestion, and the direct-tier emission carrying spec_dec.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MIN_REAL_BYTES,
	SPECDEC_MIN_RAM_GB,
	moeToken,
	mtpFromIndex,
	rebenchDue,
	safetensorsHeaderMtp,
	sizeTokenB,
	snapshotMtp,
	suggestSlot,
	type MtpCandidate,
	type ResidentRow,
} from "../bin/specdec.ts";
import { emitDirectTiers } from "../bin/registry-emit.ts";
import { SPECIALISTS, registryEntries } from "../bin/registry.ts";

const DIR = mkdtempSync(join(tmpdir(), "w242-specdec-"));
test.afterAll(() => {
	rmSync(DIR, { recursive: true, force: true });
});

test.describe("class tokens", () => {
	test("sizeTokenB reads param-class tokens, never quant suffixes @unit", () => {
		expect(sizeTokenB("mlx-community/X-35B-A3B-MTP-4bit")).toBe(35);
		expect(sizeTokenB("mlx-community/Swift-Qwen3.8-27b-oQ6e-mtp")).toBe(27);
		expect(sizeTokenB("mlx-community/Qwen3.5-122B-A10B-oQ4-mtp")).toBe(122);
		expect(sizeTokenB("mlx-community/Qwen3.8-Flash-Next-4bit-mtp")).toBe(null);
		expect(sizeTokenB("mlx-community/MTP")).toBe(null);
	});

	test("moeToken flags density tokens only @unit", () => {
		expect(moeToken("X-35B-A3B-MTP-4bit")).toBe(true);
		expect(moeToken("X-27B-MTP-4bit")).toBe(false);
		expect(moeToken("X-Flash-Next-4bit-mtp")).toBe(null);
	});
});

test.describe("snapshot detection", () => {
	test("mtpFromIndex reads weight_map keys @unit", () => {
		const p = join(DIR, "idx.json");
		writeFileSync(
			p,
			JSON.stringify({
				weight_map: {
					"mtp.fc.weight": "g0",
					"model.layer0.weight": "g0",
				},
			}),
		);
		expect(mtpFromIndex(p)).toBe(true);
		writeFileSync(
			p,
			JSON.stringify({ weight_map: { "model.layer0.weight": "g0" } }),
		);
		expect(mtpFromIndex(join(DIR, "missing.json"))).toBe(null);
	});

	test("safetensorsHeaderMtp parses an unsharded shard header @unit", () => {
		const header = {
			"mtp.fc.weight": { dtype: "F16", shape: [4], data_offsets: [0, 8] },
			"m0.weight": { dtype: "F16", shape: [4], data_offsets: [8, 16] },
		};
		const json = JSON.stringify(header);
		const buf = Buffer.alloc(8 + json.length + 4);
		buf.writeBigUInt64LE(BigInt(json.length), 0);
		buf.write(json, 8);
		const p = join(DIR, "single.safetensors");
		writeFileSync(p, buf);
		expect(safetensorsHeaderMtp(p)).toBe(true);
	});

	test("snapshotMtp resolves index → header → never-pulled @unit", () => {
		const hub = join(DIR, "hub");
		const snap = join(hub, "models--mlx-community--TinyMTP/snapshots/abc");
		mkdirSync(snap, { recursive: true });
		writeFileSync(
			join(snap, "model.safetensors.index.json"),
			JSON.stringify({ weight_map: { "mtp.fc.weight": "g0" } }),
		);
		expect(snapshotMtp(hub, "mlx-community/TinyMTP")).toBe(true);
		expect(snapshotMtp(hub, "mlx-community/NeverPulled")).toBe(null);
	});
});

test.describe("verdict gates", () => {
	const res = (over: Partial<ResidentRow>): ResidentRow => ({
		port: 8903,
		model: "x/35B",
		ram_gb: 22,
		declared: false,
		snapshot: false,
		...over,
	});
	const cand = (over: Partial<MtpCandidate>): MtpCandidate => ({
		id: "mlx-community/X-35B-A3B-MTP-4bit",
		gb: 22.6,
		sizeB: 35,
		moe: true,
		...over,
	});

	test("resident with live mtp weights on a ≥15GB slot is drift → due @unit", () => {
		const v = rebenchDue([res({ snapshot: true, declared: false })], [], []);
		expect(v.due).toBe(true);
		expect(v.residentDrift).toHaveLength(1);
	});

	test("small slots and agreeing rows never drift @unit", () => {
		expect(rebenchDue([res({ ram_gb: 2.5, snapshot: true })], [], []).due).toBe(
			false,
		);
		expect(
			rebenchDue([res({ declared: true, snapshot: true })], [], []).due,
		).toBe(false);
	});

	test("real untried 30B-class candidate is due @unit", () => {
		const v = rebenchDue([], [cand({})], []);
		expect(v.due).toBe(true);
		expect(v.challengers).toHaveLength(1);
	});

	test("phantom, sub-30B and tried candidates are filtered @unit", () => {
		const phantom = cand({ id: "m/Phantom-mtp", gb: 0.48 });
		const dense27 = cand({ id: "m/27B-MTP-mxfp8", gb: 28, sizeB: 27 });
		const triedCand = cand({ id: "m/TriedMTP", gb: 22 });
		const v = rebenchDue(
			[],
			[phantom, dense27, triedCand],
			[{ id: "m/TriedMTP", verdict: "lose", date: "2026-10-11" }],
		);
		expect(v.due).toBe(false);
		expect(v.challengers).toHaveLength(0);
	});

	test("gates constants hold @unit", () => {
		expect(MIN_REAL_BYTES).toBeGreaterThan(0.48e9);
		expect(SPECDEC_MIN_RAM_GB).toBe(15);
	});
});

test.describe("slot suggestion", () => {
	test("A3B 35-class challenger maps to the :8903 reason slot @unit", () => {
		const c: MtpCandidate = {
			id: "mlx-community/RavenX-Qwen3.6-35B-A3B-MTP-4bit",
			gb: 22.6,
			sizeB: 35,
			moe: true,
		};
		expect(suggestSlot(c, SPECIALISTS)?.port).toBe(8903);
	});
});

test.describe("emission", () => {
	test("direct tiers carry spec_dec only when declared @unit", () => {
		const plain = registryEntries().map((e) => ({
			...e,
			engine: e.engine,
		}));
		expect(emitDirectTiers(plain).includes("spec_dec")).toBe(false);
		const mtp = registryEntries().map((e) =>
			e.port === 8903 ? { ...e, spec_dec: "mtp" as const } : e,
		);
		const out = emitDirectTiers(mtp);
		expect(out.includes("    spec_dec: mtp")).toBe(true);
	});
});
