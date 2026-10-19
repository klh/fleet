// test/cache-fingerprint.test.ts — W926: privacy-safe prefix fingerprints
// classify per-lane cache misses. Unit: digest sensitivity (system/tools/
// packet/marker moves) + keyed privacy + the PrefixLedger states. Wire:
// the real handler path appends miss_cause onto lane-cache rows — hit
// banks a reference, same-fp miss = provider-eviction, differing-fp miss =
// changed-prefix, a new lane's first miss stays null (unknown), and
// openai-compat rows (writes never reported) always stay null.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	PrefixLedger,
	prefixFingerprintOf,
} from "../src/cache-fingerprint.ts";
import { LaneTelemetryLog } from "../src/cache-boundary.ts";
import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

type AnyRec = Record<string, unknown>;

const HIT = {
	input_tokens: 2,
	output_tokens: 1,
	cache_read_input_tokens: 5,
	cache_creation_input_tokens: 0,
};
const MISS = {
	input_tokens: 100,
	output_tokens: 1,
	cache_read_input_tokens: 0,
	cache_creation_input_tokens: 123,
};

describe("prefix fingerprint (W926)", () => {
	test("digest is deterministic and keyed", () => {
		const body = {
			model: "m",
			system: "You are terse.",
			messages: [{ role: "user", content: "hi" }],
		};
		const a = prefixFingerprintOf(body, "k1");
		expect(a).toBe(prefixFingerprintOf(body, "k1"));
		expect(a).toMatch(/^[0-9a-f]{16}$/);
		expect(prefixFingerprintOf(body, "k2")).not.toBe(a);
	});

	test("sensitive to system, tools, packet bytes, marker position", () => {
		const base: AnyRec = {
			model: "m",
			tools: [{ name: "t1", input_schema: { type: "object" } }],
			system: [
				{
					type: "text",
					text: "sys",
					cache_control: { type: "ephemeral" },
				},
			],
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[fleet preseed x]",
							cache_control: { type: "ephemeral" },
						},
					],
				},
			],
		};
		const fp = prefixFingerprintOf(base, "k");
		if (!fp) throw new Error("no fp");
		const sys2 = structuredClone(base);
		const sysBlock = (sys2.system as AnyRec[])[0];
		if (sysBlock) sysBlock.text = "sys2";
		expect(prefixFingerprintOf(sys2, "k")).not.toBe(fp);
		const pkt2 = structuredClone(base);
		const pktMsg = (pkt2.messages as AnyRec[])[0];
		const pktBlk = (pktMsg?.content as AnyRec[] | undefined)?.[0];
		if (pktBlk) pktBlk.text = "[fleet preseed y]";
		expect(prefixFingerprintOf(pkt2, "k")).not.toBe(fp);
		const moved = structuredClone(base);
		const mvMsg = (moved.messages as AnyRec[])[0];
		const c = (mvMsg?.content ?? []) as AnyRec[];
		delete (c[0] as AnyRec).cache_control;
		c.push({
			type: "text",
			text: "tail",
			cache_control: { type: "ephemeral" },
		});
		expect(prefixFingerprintOf(moved, "k")).not.toBe(fp);
	});

	test("implicit prefix covers the whole sequence", () => {
		const short = { model: "m", messages: [{ role: "user", content: "a" }] };
		const grown = {
			model: "m",
			messages: [
				{ role: "user", content: "a" },
				{ role: "assistant", content: "b" },
			],
		};
		expect(prefixFingerprintOf(short, "k")).not.toBe(
			prefixFingerprintOf(grown, "k"),
		);
		expect(prefixFingerprintOf({ model: "m" }, "k")).toBeNull();
	});

	test("ledger: null prior, eviction on same fp, changed on new fp", () => {
		const led = new PrefixLedger();
		expect(led.cause("b|k", "lane", "fp1")).toBeNull();
		led.observe("b|k", "lane", "fp1");
		expect(led.cause("b|k", "lane", "fp1")).toBe("provider-eviction");
		expect(led.cause("b|k", "lane", "fp2")).toBe("changed-prefix");
		expect(led.cause("b|k", "other", "fp1")).toBeNull();
	});
});

const anthropicMessage = (usage: AnyRec): Response =>
	Response.json({
		id: "msg_1",
		type: "message",
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		usage,
	});

const alignedBody = (system: string): AnyRec => ({
	model: "glm-5.3-flash",
	system,
	messages: [{ role: "user", content: "hi" }],
});

function laneDeps(url: string, d: string) {
	const pool: UpstreamPool = {
		groups: () => ["glm-5.3-flash"],
		deployments: (g) => [{ group: g, url, dialect: "anthropic" as const }],
	};
	return {
		...testDeps(pool),
		laneCache: new LaneTelemetryLog(join(d, "lane-cache.jsonl")),
		prefixLedger: new PrefixLedger(),
	};
}

const lanePost = (
	app: ReturnType<typeof createApp>,
	base: string,
	lane: string,
	body: AnyRec,
): Promise<Response> =>
	app.fetch(
		new Request(`${base}/w/${lane}/v1/messages`, {
			method: "POST",
			body: JSON.stringify(body),
		}),
	);

const rowsOf = (dir: string): AnyRec[] =>
	readFileSync(join(dir, "lane-cache.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as AnyRec);

async function openaiFixture(dir: string) {
	const upstream = await startMockUpstream(() =>
		Response.json({
			id: "1",
			choices: [],
			usage: {
				prompt_tokens: 5,
				completion_tokens: 1,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		}),
	);
	const pool: UpstreamPool = {
		groups: () => ["glm-5.3-flash"],
		deployments: (g) => [
			{ group: g, url: upstream.url, dialect: "openai" as const },
		],
	};
	const app = createApp({
		...testDeps(pool),
		laneCache: new LaneTelemetryLog(join(dir, "lane-cache.jsonl")),
		prefixLedger: new PrefixLedger(),
	});
	return { upstream, app };
}

const chatPost = (app: ReturnType<typeof createApp>, base: string) =>
	app.fetch(
		new Request(`${base}/w/lane-a/v1/chat/completions`, {
			method: "POST",
			body: JSON.stringify({
				model: "glm-5.3-flash",
				messages: [{ role: "user", content: "hi" }],
			}),
		}),
	);

describe("handler miss classification — openai rows (W926)", () => {
	test("writes never reported → miss_cause stays null", async () => {
		const dir = mkdtempSync(join(tmpdir(), "w926-fp-openai-"));
		const { upstream, app } = await openaiFixture(dir);
		await chatPost(app, upstream.url);
		await chatPost(app, upstream.url);
		const [r1, r2] = rowsOf(dir);
		expect(r1?.miss_cause).toBeNull();
		expect(r2?.miss_cause).toBeNull();
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("handler miss classification (W926)", () => {
	test("hit banks; same-fp miss = eviction; changed fp; lane isolation", async () => {
		const upstream = await startMockUpstream((req, body, n) =>
			anthropicMessage(n === 1 ? HIT : MISS),
		);
		const dir = mkdtempSync(join(tmpdir(), "w926-fp-"));
		const app = createApp(laneDeps(upstream.url, dir));
		const b1 = alignedBody("You are terse.");
		await lanePost(app, upstream.url, "lane-a", b1);
		await lanePost(app, upstream.url, "lane-a", b1);
		await lanePost(app, upstream.url, "lane-a", alignedBody("You are wordy."));
		await lanePost(app, upstream.url, "lane-b", alignedBody("You are wordy."));
		const [r1, r2, r3, r4] = rowsOf(dir);
		expect(r1?.miss_cause).toBeNull();
		expect(r1?.prefix_fp).toMatch(/^[0-9a-f]{16}$/);
		expect(r2?.miss_cause).toBe("provider-eviction");
		expect(r2?.prefix_fp).toBe(r1?.prefix_fp);
		expect(r3?.miss_cause).toBe("changed-prefix");
		expect(r3?.prefix_fp).not.toBe(r2?.prefix_fp);
		expect(r4?.miss_cause).toBeNull();
		expect(r4?.prefix_fp).toBe(r3?.prefix_fp);
		upstream.close();
		rmSync(dir, { recursive: true, force: true });
	});
});
