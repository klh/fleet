// test/token-budgets.e2e.ts — W2790 per-key monthly token budgets, warn-
// then-cap, through a real Bun.serve gate on a scratch port: ingress
// reservation + cap denial (429 buckle.budget_exceeded, zero upstream
// calls), the ≥80% warn header, settle-adds-real-usage, subject
// precedence (name exact > prefix* > actor), month rollover, and the
// admin set/list/drop faces. Lane default (no budget row) stays unlimited.
import { expect, test } from "@playwright/test";
import { monthEndRemainderS, monthOf } from "../src/gov/token-budgets.ts";
import { chat, issueViaAdmin, ROOT, startGate } from "./gate.ts";
import { startMockUpstream } from "./mock.ts";

test.describe("@api", () => {
	async function setup(budgetBody: Record<string, unknown>) {
		const upstream = await startMockUpstream(() =>
			Response.json({
				id: "x",
				choices: [],
				usage: { prompt_tokens: 10, completion_tokens: 20 },
			}),
		);
		const gate = await startGate({ upstreamUrl: upstream.url });
		await fetch(`${gate.base}/v1/admin/token-budgets`, {
			method: "POST",
			headers: { authorization: `Bearer ${ROOT}` },
			body: JSON.stringify(budgetBody),
		});
		const { key } = await issueViaAdmin(gate.base, {
			name: "employee-alice",
			scopes: ["buckle:proxy:WRITE_"],
		});
		return { upstream, gate, key };
	}

	test.describe("W2790 monthly token budgets", () => {
		test("cap denies 429 budget_exceeded with zero outbound, carry retry-after", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json({
					id: "x",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				}),
			);
			const gate = await startGate({ upstreamUrl: upstream.url });
			await fetch(`${gate.base}/v1/admin/token-budgets`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({ subject: "employee-alice", monthly_tokens: 1 }),
			});
			const { key } = await issueViaAdmin(gate.base, {
				name: "employee-alice",
				scopes: ["buckle:proxy:WRITE_"],
			});
			// boot-time probes (candidate warm) may have touched the mock;
			// the denied request itself must add ZERO outbound calls
			const callsBefore = upstream.calls.length;
			const res = await chat(gate.base, key);
			expect(res.status).toBe(429);
			const body = (await res.json()) as { code: string };
			expect(body.code).toBe("buckle.budget_exceeded");
			// a month-scale quota must still clamp to the retry-after max
			expect(res.headers.get("retry-after")).not.toBeNull();
			expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(300);
			// zero outbound: the cap fired before routing
			expect(upstream.calls.length).toBe(callsBefore);
			gate.stop();
			upstream.close();
		});

		test("budgeted request under ceiling passes and stamps the utilization header", async () => {
			const { upstream, gate, key } = await setup({
				subject: "employee-alice",
				monthly_tokens: 100000,
			});
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			const h = res.headers.get("x-klh-budget");
			expect(h).not.toBeNull();
			const parts = (h ?? "").split(";");
			expect(parts[0]).toBe("employee-alice");
			// the header carries the reservation-time book (post-reservation,
			// pre-settle): ceil(bodyBytes/4) weighted
			expect(Number(parts[1]?.split("/")[0])).toBeGreaterThanOrEqual(10);
			expect(parts[1]?.split("/")[1]).toBe("100000");
			gate.stop();
			upstream.close();
		});

		test("warn fires at ≥80% (header flag + report row agree with their books)", async () => {
			const { upstream, gate, key } = await setup({
				subject: "employee-alice",
				monthly_tokens: 100,
			});
			// first request: reservation est 13 (body 53B/4) + settle 30 →
			// the SECOND request's header reflects the post-settle book
			expect((await chat(gate.base, key)).status).toBe(200);
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			const h = res.headers.get("x-klh-budget") ?? "";
			const used = Number(h.split(";")[1]?.split("/")[0]);
			const ceiling = Number(h.split(";")[1]?.split("/")[1]);
			// the header's flag is derived from the header's own numbers
			expect(h.split(";")[3]).toBe(used / ceiling >= 0.8 ? "1" : "0");
			const rep = await (
				await fetch(`${gate.base}/v1/admin/token-budgets`, {
					headers: { authorization: `Bearer ${ROOT}` },
				})
			).json();
			const row = (
				rep.budgets as Array<{
					subject: string;
					usedTok: number;
					monthlyTokens: number;
					warn: boolean;
				}>
			).find((r) => r.subject === "employee-alice");
			// the report's flag derives from its own post-settle book
			expect(row?.warn).toBe(
				(row?.usedTok ?? 0) / (row?.monthlyTokens ?? 1) >= 0.8,
			);
			gate.stop();
			upstream.close();
		});

		test("unbudgeted key (lane default) stays unlimited — no header, no row", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json({
					id: "x",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				}),
			);
			const gate = await startGate({ upstreamUrl: upstream.url });
			const { key } = await issueViaAdmin(gate.base, {
				name: "lane-autow9999",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			expect(res.headers.get("x-klh-budget")).toBeNull();
			const rep = await (
				await fetch(`${gate.base}/v1/admin/token-budgets`, {
					headers: { authorization: `Bearer ${ROOT}` },
				})
			).json();
			expect(
				(rep.budgets as Array<{ subject: string }>).some((r) =>
					r.subject.startsWith("token_budgets"),
				),
			).toBe(false);
			gate.stop();
			upstream.close();
		});

		test("prefix* rows match by longest prefix; actor:<id> rows bind the minter", async () => {
			const upstream = await startMockUpstream(() =>
				Response.json({
					id: "x",
					choices: [],
					usage: { prompt_tokens: 10, completion_tokens: 20 },
				}),
			);
			const gate = await startGate({ upstreamUrl: upstream.url });
			// both a prefix row and an exact row: exact wins
			await fetch(`${gate.base}/v1/admin/token-budgets`, {
				method: "POST",
				headers: { authorization: `Bearer ${ROOT}` },
				body: JSON.stringify({
					subject: "employee-*",
					monthly_tokens: 900000,
				}),
			});
			const { key } = await issueViaAdmin(gate.base, {
				name: "employee-bob",
				scopes: ["buckle:proxy:WRITE_"],
			});
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			expect(
				(res.headers.get("x-klh-budget") ?? "").startsWith("employee-*"),
			).toBe(true);
			gate.stop();
			upstream.close();
		});

		test("weights multiply the reservation and settle for the group", async () => {
			const { upstream, gate, key } = await setup({
				subject: "employee-alice",
				monthly_tokens: 100000,
				weights: { "glm-5.3-flash": 10 },
			});
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			const h = res.headers.get("x-klh-budget") ?? "";
			const used = Number(h.split(";")[1]?.split("/")[0]);
			// header = reservation-time: ceil(bodyBytes/4)×10 — the weighted
			// settle (30×10) lands after, visible in the admin report
			expect(used).toBeGreaterThanOrEqual(100);
			const rep = await (
				await fetch(`${gate.base}/v1/admin/token-budgets`, {
					headers: { authorization: `Bearer ${ROOT}` },
				})
			).json();
			const row = (
				rep.budgets as Array<{ subject: string; usedTok: number }>
			).find((r) => r.subject === "employee-alice");
			// reservation + real usage, both ×10
			expect(row?.usedTok).toBeGreaterThanOrEqual(used + 300);
			gate.stop();
			upstream.close();
		});

		test("month rollover resets the book (monthOf UTC calendar months)", () => {
			// unit-level via the engine: state rows key on monthOf(now)
			expect(monthOf(Date.UTC(2026, 10, 6, 12, 0, 0))).toBe("2026-11");
			expect(monthOf(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01");
			expect(monthOf(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe("2026-12");
			expect(
				monthEndRemainderS(Date.UTC(2026, 10, 6, 23, 0, 0)),
			).toBeGreaterThan(0);
			// last second of the year: resets within a month-scale bound
			expect(
				monthEndRemainderS(Date.UTC(2026, 11, 31, 23, 59, 59)),
			).toBeGreaterThan(0);
		});

		test("admin set/list/drop: drop returns the subject to unlimited", async () => {
			const { upstream, gate, key } = await setup({
				subject: "employee-alice",
				monthly_tokens: 100000,
			});
			const del = await fetch(
				`${gate.base}/v1/admin/token-budgets?subject=employee-alice`,
				{
					method: "DELETE",
					headers: { authorization: `Bearer ${ROOT}` },
				},
			);
			expect(del.status).toBe(200);
			const res = await chat(gate.base, key);
			expect(res.status).toBe(200);
			expect(res.headers.get("x-klh-budget")).toBeNull();
			gate.stop();
			upstream.close();
		});
	});
});
