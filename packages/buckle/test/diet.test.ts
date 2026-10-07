// test/diet.test.ts — W207 loop-level trajectory pruning: the deterministic
// pass over both dialects, stanza parsing, the metered wire seam, the
// rid-keyed sidestore + routes, and the e2e (declared request → the pruned
// body is what the upstream sees; elided raw one GET away by rid).
import { describe, expect, test } from "bun:test";
import { AidsLedger, parseAids } from "../src/aids.ts";
import { type AidsDeps, applyWireAids } from "../src/aids-routes.ts";
import {
	DIET_DEFAULTS,
	DietStore,
	dietRoutes,
	pruneOptsOf,
	pruneTrajectory,
} from "../src/diet.ts";
import { type AppDeps, createApp } from "../src/handlers.ts";
import { Preseeder } from "../src/preseed.ts";
import { servicemon } from "../src/servicemon.ts";
import type { UpstreamPool } from "../src/upstreams.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";

type AnyRec = Record<string, unknown>;

const xs = (n: number): string => "x".repeat(n);

// ─── fixtures ───────────────────────────────────────────────────────────────
/** Six tool exchanges: ages 6..1; sizes 10/8/12/3/9/6 KB. */
function anthropicTrajectory(): AnyRec {
	const ex = (i: number, tool: string, kb: number): [AnyRec, AnyRec] => [
		{
			role: "assistant",
			content: [
				{ type: "text", text: `step ${i}` },
				{ type: "tool_use", id: `t${i}`, name: tool, input: {} },
			],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: `t${i}`, content: xs(kb * 1024) },
			],
		},
	];
	const [a1, r1] = ex(1, "Bash", 10);
	const [a2, r2] = ex(2, "Read", 8);
	const [a3, r3] = ex(3, "Bash", 12);
	const [a4, r4] = ex(4, "Grep", 3);
	const [a5, r5] = ex(5, "planned-vs-done", 9);
	const [a6, r6] = ex(6, "Bash", 6);
	return {
		model: "glm-5-3-flash",
		system: "you are terse",
		messages: [
			{ role: "user", content: "fix the gate" },
			a1,
			r1,
			a2,
			r2,
			a3,
			r3,
			a4,
			r4,
			a5,
			r5,
			a6,
			r6,
		],
	};
}
/** Same trajectory, openai wire shape. */
function openaiTrajectory(): AnyRec {
	const ex = (i: number, tool: string, kb: number): [AnyRec, AnyRec] => [
		{
			role: "assistant",
			content: `step ${i}`,
			tool_calls: [
				{
					id: `c${i}`,
					type: "function",
					function: { name: tool, arguments: "{}" },
				},
			],
		},
		{ role: "tool", tool_call_id: `c${i}`, content: xs(kb * 1024) },
	];
	const [a1, r1] = ex(1, "Bash", 10);
	const [a2, r2] = ex(2, "Read", 8);
	const [a3, r3] = ex(3, "Diet", 12);
	const [a4, r4] = ex(4, "Grep", 3);
	const [a5, r5] = ex(5, "Bash", 9);
	const [a6, r6] = ex(6, "Read", 6);
	return {
		model: "glm-5-3-flash",
		messages: [
			{ role: "system", content: "you are terse" },
			{ role: "user", content: "fix the gate" },
			a1,
			r1,
			a2,
			r2,
			a3,
			r3,
			a4,
			r4,
			a5,
			r5,
			a6,
			r6,
		],
	};
}

const OPTS = { ...DIET_DEFAULTS };
// ─── the pure pass (anthropic) ──────────────────────────────────────────────

describe("pruneTrajectory (anthropic)", () => {
	test("old big results tombstoned; keep-window + sub-min survive", () => {
		const input = anthropicTrajectory();
		const before = JSON.stringify(input);
		const out = pruneTrajectory(input, "anthropic", OPTS);
		// copy-on-write: input untouched, fresh body out
		expect(JSON.stringify(input)).toEqual(before);
		expect(out.body).not.toBe(input);
		const msgs = out.body.messages as AnyRec[];
		const first = (i: number): AnyRec =>
			(msgs[i]?.content as AnyRec[] | undefined)?.[0] as AnyRec;
		// ages 6/5/4 → tombstoned (keep 3), seq 0/1/2, tool names resolved
		expect(first(2).content).toBe(
			"[buckle diet: elided Bash result (~10.0KB, 6 tool-turns old)]",
		);
		expect(first(4).content).toBe(
			"[buckle diet: elided Read result (~8.0KB, 5 tool-turns old)]",
		);
		expect(first(6).content).toBe(
			"[buckle diet: elided Bash result (~12.0KB, 4 tool-turns old)]",
		);
	});
});
describe("pruneTrajectory (anthropic laws)", () => {
	test("keep-window boundary + sub-min bytes survive; text never touched", () => {
		const input = anthropicTrajectory();
		const out = pruneTrajectory(input, "anthropic", OPTS);
		const msgs = out.body.messages as AnyRec[];
		const first = (i: number): AnyRec =>
			(msgs[i]?.content as AnyRec[] | undefined)?.[0] as AnyRec;
		// age-3 result (3KB) sits at the keep boundary and survives
		expect((first(8).content as string).length).toBe(3 * 1024);
		// the task statement + assistant prose survive untouched
		expect(msgs[0]?.content).toBe("fix the gate");
		expect((msgs[1]?.content as AnyRec[] | undefined)?.[0]?.type).toBe("text");
	});

	test("sub-minimum old results survive (bytes law)", () => {
		const pair = (): [AnyRec, AnyRec] => [
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "s", name: "Bash", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "s", content: xs(300) }],
			},
		];
		const [a1, r1] = pair();
		const [a2, r2] = pair();
		const [a3, r3] = pair();
		const [a4, r4] = pair();
		const body = {
			model: "m",
			messages: [
				{ role: "user", content: "task" },
				a1,
				r1,
				a2,
				r2,
				a3,
				r3,
				a4,
				r4,
			],
		};
		// ages 4..1, all 300B < min → nothing doomed
		const out = pruneTrajectory(body, "anthropic", OPTS);
		expect(out.events).toHaveLength(0);
		expect(out.body).toBe(body);
	});
});
// ─── the pure pass (openai + shared pass laws) ──────────────────────────────

describe("pruneTrajectory (openai + determinism)", () => {
	test("role:tool carriers tombstoned; names from tool_calls", () => {
		const input = openaiTrajectory();
		const out = pruneTrajectory(input, "openai", OPTS);
		const msgs = out.body.messages as AnyRec[];
		// msg layout: 0 system, 1 user, then pairs; tool msgs at 3,5,7,9,11,13
		expect(String(msgs[3]?.content ?? "").startsWith("[buckle diet:")).toBe(
			true,
		);
		expect(msgs[5]?.content).toBe(
			"[buckle diet: elided Read result (~8.0KB, 5 tool-turns old)]",
		);
		// role + tool_call_id survive on the carrier
		expect(msgs[3]?.tool_call_id).toBe("c1");
		expect(msgs[3]?.role).toBe("tool");
		// recent window intact
		expect(String(msgs[11]?.content ?? "").length).toBe(9 * 1024);
		expect(String(msgs[13]?.content ?? "").length).toBe(6 * 1024);
		// system + task statement untouched
		expect(msgs[0]?.role).toBe("system");
		expect(msgs[1]?.content).toBe("fix the gate");
	});

	test("deterministic + idempotent: replay adds nothing, changes nothing", () => {
		const once = pruneTrajectory(anthropicTrajectory(), "anthropic", OPTS);
		const twice = pruneTrajectory(once.body, "anthropic", OPTS);
		expect(twice.events).toHaveLength(0);
		expect(twice.body).toBe(once.body); // no-touch outcome shares the ref
		const again = pruneTrajectory(anthropicTrajectory(), "anthropic", OPTS);
		expect(JSON.stringify(again.body)).toBe(JSON.stringify(once.body));
	});
});
// ─── stanza + policy mapping ─────────────────────────────────────────────────

describe("prune stanza + opts", () => {
	test("parseAids: prune parses; composes", () => {
		expect(parseAids("prune").prune).toBe(true);
		expect(parseAids("prune cache-align").prune).toBe(true);
		expect(parseAids("prune cache-align")["cache-align"]).toBe(true);
	});

	test("off wins over everything", () => {
		const off = parseAids("off prune");
		expect(off.off).toBe(true);
	});

	test("pruneOptsOf: defaults, then policy overrides", () => {
		expect(pruneOptsOf({})).toEqual(DIET_DEFAULTS);
		expect(pruneOptsOf({ prune: { keep_turns: 5, min_bytes: 4096 } })).toEqual({
			keepTurns: 5,
			minResultBytes: 4096,
			maxStoreBytes: 65536,
		});
	});
});
// ─── the metered wire seam ──────────────────────────────────────────────────

describe("applyPrune via applyWireAids", () => {
	const mkDeps = (
		policy: AidsDeps["aidsPolicy"],
		diet?: DietStore,
	): AidsDeps => ({
		aids: new AidsLedger(":memory:"),
		preseeder: new Preseeder({ policy }),
		aidsPolicy: policy,
		sm: servicemon({ service: "t", port: 0 }),
		...(diet ? { diet } : {}),
	});

	test("policy off → skipped(policy), zero touch", async () => {
		const d = mkDeps({});
		const body = anthropicTrajectory();
		const out = await applyWireAids(d, "prune", body, "anthropic", "r1");
		expect(out.body).toBe(body);
		const ev = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev.aid).toBe("prune");
		expect(ev.decision).toBe("skipped");
		expect(ev.skip_reason).toBe("policy");
	});
});
describe("applyPrune via applyWireAids (gainful path)", () => {
	const mkDeps = (
		policy: AidsDeps["aidsPolicy"],
		diet?: DietStore,
	): AidsDeps => ({
		aids: new AidsLedger(":memory:"),
		preseeder: new Preseeder({ policy }),
		aidsPolicy: policy,
		sm: servicemon({ service: "t", port: 0 }),
		...(diet ? { diet } : {}),
	});

	test("policy on → rewritten body + store rows + injected event", async () => {
		const d = mkDeps({ prune: { default: "on" } }, new DietStore(":memory:"));
		const body = anthropicTrajectory();
		const out = await applyWireAids(d, "prune", body, "anthropic", "r2");
		expect(out.body).not.toBe(body);
		const msgs = out.body.messages as AnyRec[];
		const c0 = ((msgs[2]?.content ?? []) as AnyRec[])[0] as AnyRec;
		expect(c0.content).toBe(
			"[buckle diet: elided Bash result (~10.0KB, 6 tool-turns old)]",
		);
		expect(d.diet?.get("r2")).toHaveLength(3);
		const ev = d.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev.decision).toBe("injected");
	});

	test("no store → skipped(unavailable); fresh body → skipped(no_gain)", async () => {
		const bare = mkDeps({ prune: { default: "on" } });
		const out = await applyWireAids(
			bare,
			"prune",
			anthropicTrajectory(),
			"anthropic",
		);
		const ev1 = bare.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev1.skip_reason).toBe("unavailable");
		expect(out.body).not.toBeNull();
		const rich = mkDeps(
			{ prune: { default: "on" } },
			new DietStore(":memory:"),
		);
		const small = {
			model: "m",
			messages: [
				{ role: "user", content: "task" },
				{
					role: "assistant",
					content: [{ type: "tool_use", id: "z", name: "Bash", input: {} }],
				},
				{
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "z", content: "tiny" }],
				},
			],
		};
		await applyWireAids(rich, "prune", small, "anthropic");
		const ev2 = rich.aids.eventsSince(0)[0] as Record<string, unknown>;
		expect(ev2.skip_reason).toBe("no_gain");
	});
});
// ─── the store + routes ──────────────────────────────────────────────────────

describe("DietStore", () => {
	test("put/get roundtrip carries raw + truncation flag", () => {
		const s = new DietStore(":memory:");
		s.put("rA", "anthropic", [
			{
				seq: 0,
				tool: "Bash",
				age: 6,
				bytes: 10240,
				raw: xs(10240),
				raw_truncated: false,
			},
			{
				seq: 1,
				tool: "Read",
				age: 5,
				bytes: 8192,
				raw: xs(8192),
				raw_truncated: false,
			},
		]);
		const rows = s.get("rA");
		expect(rows).not.toBeNull();
		expect(rows).toHaveLength(2);
		expect(rows?.[0]?.tool).toBe("Bash");
		expect((rows?.[0]?.raw ?? "").length).toBe(10240);
		expect(rows?.[0]?.raw_truncated).toBe(0);
		expect(s.get("zz")).toBeNull();
		s.close();
	});

	test("bounded: the 201st rid evicts the oldest", () => {
		const s = new DietStore(":memory:");
		for (let i = 1; i <= 201; i++)
			s.put(`r${i}`, "openai", [
				{
					seq: 0,
					tool: "Bash",
					age: 2,
					bytes: 10,
					raw: "raw",
					raw_truncated: false,
				},
			]);
		expect(s.get("r1")).toBeNull();
		expect(s.get("r2")).not.toBeNull();
		expect(s.get("r201")).not.toBeNull();
		s.close();
	});
});

describe("diet routes", () => {
	const seeded = (): DietStore => {
		const s = new DietStore(":memory:");
		s.put("rX", "anthropic", [
			{
				seq: 0,
				tool: "Bash",
				age: 4,
				bytes: 512,
				raw: "the raw bytes",
				raw_truncated: false,
			},
		]);
		return s;
	};

	test("rid GET returns the elided raw content", async () => {
		const res = await dietRoutes(
			{ diet: seeded() },
			new Request("http://x/diet/rX"),
			"/diet/rX",
		);
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			rid: string;
			rows: Array<{ raw: string; tool: string }>;
		};
		expect(body.rid).toBe("rX");
		expect(body.rows[0]?.raw).toBe("the raw bytes");
		expect(body.rows[0]?.tool).toBe("Bash");
	});
});
describe("diet routes (list + honest 404s)", () => {
	const seeded = (): DietStore => {
		const s = new DietStore(":memory:");
		s.put("rX", "anthropic", [
			{
				seq: 0,
				tool: "Bash",
				age: 4,
				bytes: 512,
				raw: "the raw bytes",
				raw_truncated: false,
			},
		]);
		return s;
	};

	test("list face + 404 miss + bare-deps 404", async () => {
		const deps = { diet: seeded() };
		const list = await dietRoutes(deps, new Request("http://x/diet"), "/diet");
		const lb = (await list?.json()) as { rows: Array<{ rid: string }> };
		expect(lb.rows[0]?.rid).toBe("rX");
		const miss = await dietRoutes(
			deps,
			new Request("http://x/diet/zz"),
			"/diet/zz",
		);
		expect(miss?.status).toBe(404);
		const bare = await dietRoutes(
			{},
			new Request("http://x/diet/rX"),
			"/diet/rX",
		);
		expect(bare?.status).toBe(404);
	});
});
// ─── wire e2e: prune through createApp ──────────────────────────────────────

describe("wire e2e: prune through createApp", () => {
	const POOL = (url: string): UpstreamPool => ({
		groups: () => ["glm-5-3-flash"],
		deployments: (g) => [{ group: g, url, dialect: "anthropic" as const }],
	});

	test("declared request: the pruned body is what rides OUT", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					JSON.stringify({
						id: "msg_1",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						usage: { input_tokens: 9, output_tokens: 5 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const d = {
			...testDeps(POOL(upstream.url), {
				policy: { aids: { prune: { default: "on" } } },
			}),
			diet: new DietStore(":memory:"),
		} as AppDeps & { diet: DietStore };
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				headers: { "x-belt-aids": "prune" },
				body: JSON.stringify(anthropicTrajectory()),
			}),
		);
		expect(res.status).toBe(200);
		const sent = (upstream.calls[0]?.body ?? {}) as AnyRec;
		const sentMsgs = sent.messages as AnyRec[];
		const c0 = ((sentMsgs[2]?.content ?? []) as AnyRec[])[0] as AnyRec;
		expect(c0.content).toBe(
			"[buckle diet: elided Bash result (~10.0KB, 6 tool-turns old)]",
		);
		upstream.close();
	});
});
describe("wire e2e: prune (kept window + raw one GET away)", () => {
	const POOL = (url: string): UpstreamPool => ({
		groups: () => ["glm-5-3-flash"],
		deployments: (g) => [{ group: g, url, dialect: "anthropic" as const }],
	});

	test("keep window rides out verbatim; elided raw one GET away", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					JSON.stringify({
						id: "msg_2",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						usage: { input_tokens: 9, output_tokens: 5 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const d = {
			...testDeps(POOL(upstream.url), {
				policy: { aids: { prune: { default: "on" } } },
			}),
			diet: new DietStore(":memory:"),
		} as AppDeps & { diet: DietStore };
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				headers: { "x-belt-aids": "prune" },
				body: JSON.stringify(anthropicTrajectory()),
			}),
		);
		const rid = res.headers.get("x-belt-rid") ?? "";
		const sentMsgs = ((upstream.calls[0]?.body ?? {}) as AnyRec)
			.messages as AnyRec[];
		const kept = ((sentMsgs[8]?.content ?? []) as AnyRec[])[0] as AnyRec;
		expect(String(kept.content ?? "").length).toBe(3 * 1024);
		const raw = await app.fetch(new Request(`${upstream.url}/diet/${rid}`));
		expect(raw.status).toBe(200);
		const row = (await raw.json()) as {
			rows: Array<{ raw: string; bytes: number }>;
		};
		expect(row.rows).toHaveLength(3);
		expect(String(row.rows[0]?.raw ?? "").length).toBe(10 * 1024);
		expect(row.rows[0]?.bytes).toBe(10 * 1024);
		upstream.close();
	});

	test("undeclared → byte-identical pass-through, no diet rows", async () => {
		const upstream = await startMockUpstream(
			() =>
				new Response(
					JSON.stringify({
						id: "msg_3",
						type: "message",
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						usage: { input_tokens: 9, output_tokens: 5 },
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const d = {
			...testDeps(POOL(upstream.url), {
				policy: { aids: { prune: { default: "on" } } },
			}),
			diet: new DietStore(":memory:"),
		} as AppDeps & { diet: DietStore };
		const app = createApp(d);
		const res = await app.fetch(
			new Request(`${upstream.url}/v1/messages`, {
				method: "POST",
				body: JSON.stringify(anthropicTrajectory()),
			}),
		);
		expect(res.status).toBe(200);
		const sentMsgs = ((upstream.calls[0]?.body ?? {}) as AnyRec)
			.messages as AnyRec[];
		const c0 = ((sentMsgs[2]?.content ?? []) as AnyRec[])[0] as AnyRec;
		expect(String(c0.content ?? "").length).toBe(10 * 1024);
		const rid = res.headers.get("x-belt-rid") ?? "";
		expect(d.diet.get(rid)).toBeNull();
		upstream.close();
	});
});
