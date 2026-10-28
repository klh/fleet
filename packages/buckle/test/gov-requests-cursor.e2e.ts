// test/gov-requests-cursor.e2e.ts — W925 request-audit keyset pagination:
// until + before_rid continues strictly after the (ts, rid) cursor row, so a
// same-ts tie group larger than one page walks without loss or repeats.
import { expect, test } from "@playwright/test";
import { Ledger } from "../src/ledger.ts";
import { issueViaAdmin, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

const BASE_ROW = {
	actor: "w925keyset",
	lane: "lane-nine",
	dialect: "openai",
	hint: "",
	candidates_seen: 1,
	candidates_top: "m",
	target_kind: null,
	target_host: null,
	target_port: null,
	target_model: "glm-5.3-flash",
	decision: "policy",
	latency_class: "proven",
	tier: "cloud",
	allow_cloud: true,
	error_code: null,
	why: "",
	hop: "origin" as const,
};

test.describe("@unit", () => {
	test("W925 keyset cursor walks a >500 same-ts tie group", () => {
		const ledger = new Ledger(
			`/tmp/buckle-w925-keyset-${Date.now()}-${process.pid}.db`,
			undefined,
			{ flushMs: 10_000 },
		);
		for (let i = 0; i < 520; i++)
			ledger.auditDecision({
				...BASE_ROW,
				rid: `t${String(i).padStart(3, "0")}`,
				ts: "2026-10-19T12:00:00.000Z",
			});
		for (let i = 0; i < 10; i++)
			ledger.auditDecision({
				...BASE_ROW,
				rid: `n${i}`,
				ts: "2026-10-19T12:00:05.000Z",
			});
		const seen: string[] = [];
		let until: string | undefined;
		let beforeRid: string | undefined;
		for (;;) {
			const got = ledger.requestsRead({ limit: 500, until, beforeRid });
			for (const r of got) seen.push(r.rid);
			const tail = got.at(-1);
			if (got.length < 500 || !tail) break;
			until = tail.ts;
			beforeRid = tail.rid;
		}
		expect(seen.length).toBe(530);
		expect(new Set(seen).size).toBe(530);
		expect(new Set(seen).has("t000")).toBe(true);
		ledger.close();
	});

	test("W925 before_rid without until is refused", async () => {
		const upstream = await startMockUpstream(() =>
			Response.json({ id: "w925", choices: [] }),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		try {
			const admin = await issueViaAdmin(gate.base, {
				name: "w925-guard",
				scopes: ["buckle:admin:READ_"],
			});
			const res = await fetch(
				`${gate.base}/v1/admin/requests?before_rid=t030`,
				{ headers: { authorization: `Bearer ${admin.key}` } },
			);
			expect(res.status).toBe(400);
			expect(((await res.json()) as { code?: string }).code).toBe(
				"buckle.bad_window",
			);
		} finally {
			gate.stop();
			upstream.close();
		}
	});
});
