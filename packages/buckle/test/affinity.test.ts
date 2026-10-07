// test/affinity.test.ts — W237: byte-stable packet layout + prefix-affinity
// dispatch. Layout: the packet block relocates to the head of the message
// sequence (system → packet → volatile, breakpoint right after it); the
// volatile preamble keeps its order behind the packet. Affinity: the first
// delivered candidate owns the prefix for the TTL window; the memo is
// LRU-bounded; `must` hints and benched rows are never reordered.
import { describe, expect, test } from "bun:test";
import { affKeyOf, applyAffinity, PrefixAffinity } from "../src/affinity.ts";
import { alignBody } from "../src/align.ts";
import type { CandidateRow } from "../src/candidates.ts";
import type { RouteSelection } from "../src/decide.ts";
import { decideRoute } from "../src/decide.ts";
import type { Prefs } from "../src/policy.ts";
import { renderPacket } from "../src/preseed.ts";

let seq = 0;
const row = (over: Partial<CandidateRow> = {}): CandidateRow => ({
	candidate_id: `h:${String(9000 + seq++)}:m`,
	kind: "local",
	host: "h",
	port: 9000 + seq,
	model: "m",
	dialect: "anthropic",
	group: "g",
	capability_text: "m",
	dep: {
		group: "g",
		url: `http://h:${String(9000 + seq)}`,
		dialect: "anthropic",
	},
	healthy: true,
	estimate_ms: null,
	calls: 0,
	errors: 0,
	load: 0,
	last_used: null,
	...over,
});

const PREFS: Prefs = { cost_speed: "balanced", allow_cloud: true };

const selOf = (rows: CandidateRow[]): RouteSelection => {
	const r = decideRoute({
		hint: null,
		hintRaw: "",
		candidates: rows,
		prefs: PREFS,
		dialect: "anthropic",
	});
	if (!r.ok) throw new Error("no selection in fixture");
	return r.sel;
};

const packetBody = (
	packet: string,
	extra?: {
		tail?: string;
	},
): Record<string, unknown> => ({
	model: "g",
	messages: [
		{
			role: "user",
			content: [
				{ type: "text", text: packet },
				...(extra?.tail ? [{ type: "text", text: extra.tail }] : []),
			],
		},
	],
});

const PKT = renderPacket("gaps", [
	{
		kind: "knowledge",
		id: 7,
		topic: "t",
		fact: "a stable fleet fact",
		state: "active",
		trust: "verified",
		source_ref: "README.md",
	},
]);

describe("layout: system → packet → volatile", () => {
	test("packet after volatile content relocates to the prefix", () => {
		const body = {
			model: "g",
			messages: [
				{ role: "user", content: "the per-lane brief (volatile)" },
				{
					role: "user",
					content: [{ type: "text", text: `preamble\n${PKT}` }],
				},
			],
		};
		const r = alignBody(body, "anthropic");
		expect(r?.placed).toBe("packet");
		const msgs = body.messages as Array<Record<string, unknown>>;
		expect(msgs.length).toBe(2);
		const content = msgs[0].content as Array<Record<string, unknown>>;
		expect(content[0].text).toBe(PKT);
		expect(content[0].cache_control).toEqual({ type: "ephemeral" });
		expect(content[1].text).toBe("the per-lane brief (volatile)");
		const pre = msgs[1].content as Array<Record<string, unknown>>;
		expect(pre[0].text).toBe("preamble");
	});
});

describe("affKeyOf", () => {
	test("same packet bytes → same key; volatile tail never enters", () => {
		const a = packetBody(PKT, { tail: "lane one" });
		const b = packetBody(PKT, { tail: "lane two" });
		expect(affKeyOf(a)).toBe(affKeyOf(b));
	});
	test("different packet bytes → different key", () => {
		const pkt2 = renderPacket("other", [
			{
				kind: "knowledge",
				id: 9,
				topic: "u",
				fact: "another fact",
				state: "active",
				trust: "verified",
			},
		]);
		const a = packetBody(PKT);
		const b = packetBody(pkt2);
		expect(affKeyOf(a)).not.toBe(affKeyOf(b));
	});
});

describe("PrefixAffinity memo", () => {
	test("bind → probe; expiry drops the entry", () => {
		let t = 1000;
		const aff = new PrefixAffinity(50_000, () => t);
		aff.bind("k", "cand-a");
		expect(aff.probe("k")).toBe("cand-a");
		t += 49_999;
		expect(aff.probe("k")).toBe("cand-a");
		t += 1;
		expect(aff.probe("k")).toBe(null);
	});
});

describe("applyAffinity", () => {
	test("reorders the bound candidate to the head", () => {
		const a = row();
		const b = row();
		const c = row();
		const sel = selOf([a, b, c]);
		const out = applyAffinity(sel, c.candidate_id);
		expect(out === sel).toBe(false);
		expect(out.ordered[0].candidate_id).toBe(c.candidate_id);
		expect(out.ordered[1].candidate_id).toBe(a.candidate_id);
		expect(out.ordered[2].candidate_id).toBe(b.candidate_id);
		expect(out.head.candidate_id).toBe(c.candidate_id);
		expect(out.why).toContain("prefix-affinity");
		expect(out.top).toEqual([c.candidate_id, a.candidate_id, b.candidate_id]);
	});
});

describe("applyAffinity skips", () => {
	test("same object back on: null id, must verb, absent id, benched row", () => {
		const a = row();
		const b = row({ healthy: false });
		const c = row();
		const sel = selOf([a, b, c]);
		expect(applyAffinity(sel, null) === sel).toBe(true);
		expect(applyAffinity(sel, "no-such-id") === sel).toBe(true);
		expect(applyAffinity(sel, b.candidate_id) === sel).toBe(true);
		const must = selOf([a, b, c]);
		must.verb = "must";
		expect(applyAffinity(must, c.candidate_id) === must).toBe(true);
	});
	test("already head → identity preserved", () => {
		const a = row();
		const sel = selOf([a, row()]);
		expect(applyAffinity(sel, a.candidate_id) === sel).toBe(true);
	});
});

describe("wire: prefix-affinity e2e", () => {
	test("packet requests stick to one provider identity", async () => {
		const mk = () =>
			startMockUpstream(() =>
				Response.json({
					id: "x",
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			);
		const upA = await mk();
		const upB = await mk();
		const dep = (u: { url: string }, g: string) => ({
			group: g,
			url: u.url,
			dialect: "anthropic" as const,
		});
		const pool: UpstreamPool = {
			groups: () => ["g"],
			deployments: (g) => [dep(upA, g), dep(upB, g)],
		};
		const d = testDeps(pool);
		d.affinity = new PrefixAffinity(60_000, () => Date.now());
		const app = createApp(d);
		const raw = JSON.stringify(packetBody(PKT));
		const post = () =>
			app.fetch(
				new Request("http://gate/v1/messages", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: raw,
				}),
			);
		expect((await post()).status).toBe(200);
		expect((await post()).status).toBe(200);
		const landedA = upA.calls.length;
		const landedB = upB.calls.length;
		expect(landedA + landedB).toBe(2);
		const sticky = (landedA === 2 || landedB === 2) && landedA + landedB === 2;
		expect(sticky).toBe(true);
		const stickyUp = landedA === 2 ? upA : upB;
		expect(d.affinity.probe(affKeyOf(packetBody(PKT)))).toBe(
			`127.0.0.1:${String(stickyUp.port)}:g`,
		);
		upA.close();
		upB.close();
	});
});

import { createApp } from "../src/handlers.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";
