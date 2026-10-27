// test/hop-deadline.test.ts — W1118.1: the shared hop contract through the
// Buckle ladder. Unit: admission verdicts, child emission, the root budget.
// Real-socket: an A→B→A cycle refuses as a typed traced failure (provider
// never reached); a root budget of 1 429s at the next hop (decrement
// proof); an expired deadline 504s at admission; a mid-walk contract
// deadline clamps the walk; the trace id passes through untouched while
// external provider egress stays contract-less.
import { describe, expect, test } from "bun:test";
import {
	admitHopContract,
	childHopHeaderValue,
	HOP_CONTRACT_HEADER,
	hopContractRoot,
	isContractHop,
} from "../src/hop-deadline.ts";
import {
	encodeHopContract,
	rungIdOf,
} from "../../telemetry/src/hop-contract.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import type { Ledger } from "../src/ledger.ts";
import { testDeps } from "./deps.ts";
import { startMockUpstream } from "./mock.ts";
import type { GatewayPolicy } from "../src/policy.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";

const MODEL = "glm-5.3-flash";
const NOW = 1_792_600_000_000;

interface TestHub {
	app: { fetch(req: Request): Promise<Response> };
	ledger: Ledger;
}

interface HubOpts {
	policy?: Record<string, unknown>;
}

/** One buckle hop: a full testDeps app over the given deployment legs. The
 *  app rides the servicemon wrapper (a buckle peer's GET /status relay
 *  pre-flight is answered there; a raw app.fetch would 405 it). Retry
 *  sleeps are instant so refusal ladders stay fast. */
async function hub(
	hubId: string,
	legs: Deployment[],
	opts: HubOpts = {},
): Promise<TestHub> {
	const pool = {
		groups: () => [MODEL],
		deployments: (g: string): Deployment[] => (g === MODEL ? legs : []),
	} satisfies UpstreamPool;
	const deps: AppDeps = {
		...testDeps(pool, {
			policy: { num_retries: 1, ...opts.policy } as GatewayPolicy,
			sleepMs: async () => {},
		}),
		hubId,
	};
	const app = createApp(deps);
	return { app: { fetch: deps.sm.fetch(app.fetch) }, ledger: deps.ledger };
}

describe("admission verdicts", () => {
	const rung = "a".repeat(16);
	test("a valid header admits with its fields", () => {
		const v = encodeHopContract({
			deadlineMs: NOW + 5000,
			budget: 2,
			path: [rung],
		});
		const a = admitHopContract(v, NOW, "b".repeat(16));
		expect(a.ok).toBe(true);
		if (a.ok) expect(a.contract?.budget).toBe(2);
	});
	test("an absent header admits with a null contract (fresh entry)", () => {
		expect(admitHopContract(null, NOW, rung)).toEqual({
			ok: true,
			contract: null,
		});
	});
	test("malformed and wrong-version headers refuse 400 invalid", () => {
		for (const bad of ["v=2;x", "zzz"]) {
			const a = admitHopContract(bad, NOW, rung);
			expect(a.ok).toBe(false);
			if (!a.ok) expect(a.denial.status).toBe(400);
			if (!a.ok) expect(a.denial.code).toBe("hop_contract_invalid");
		}
	});
	test("a past deadline refuses 504 expired", () => {
		const v = encodeHopContract({ deadlineMs: NOW - 1, budget: 2, path: [] });
		const a = admitHopContract(v, NOW, rung);
		expect(a.ok).toBe(false);
		if (!a.ok) expect(a.denial.status).toBe(504);
		if (!a.ok) expect(a.denial.code).toBe("hop_contract_expired");
	});
	test("an empty budget refuses 429 exhausted", () => {
		const v = encodeHopContract({ deadlineMs: NOW + 1000, budget: 0, path: [] });
		const a = admitHopContract(v, NOW, rung);
		expect(a.ok).toBe(false);
		if (!a.ok) expect(a.denial.status).toBe(429);
		if (!a.ok) expect(a.denial.code).toBe("hop_contract_budget_exhausted");
	});
	test("a visited own rung refuses 400 repeated_rung", () => {
		const v = encodeHopContract({
			deadlineMs: NOW + 1000,
			budget: 2,
			path: [rung, "c".repeat(16)],
		});
		const a = admitHopContract(v, NOW, rung);
		expect(a.ok).toBe(false);
		if (!a.ok) expect(a.denial.status).toBe(400);
		if (!a.ok) expect(a.denial.code).toBe("hop_contract_repeated_rung");
	});
});

describe("child emission and root", () => {
	const own = "a".repeat(16);
	test("the child decrements the budget and appends own rung once", () => {
		const child = childHopHeaderValue({
			deadlineMs: NOW + 5000,
			budget: 2,
			path: [],
			ownRung: own,
		});
		expect(child).toBe(
			`v=1;deadline=${String(NOW + 5000)};budget=1;path=${own}`,
		);
	});
	test("a retry of the same rung stays the same rung", () => {
		const retry = childHopHeaderValue({
			deadlineMs: NOW + 5000,
			budget: 2,
			path: [own],
			ownRung: own,
		});
		expect(retry).toBe(
			`v=1;deadline=${String(NOW + 5000)};budget=1;path=${own}`,
		);
	});
	test("an unencodable rung refuses (null, never contract-less)", () => {
		expect(
			childHopHeaderValue({
				deadlineMs: NOW,
				budget: 1,
				path: [],
				ownRung: "NOPE",
			}),
		).toBeNull();
	});
	test("the root floors at now and clamps a negative budget", () => {
		const root = hopContractRoot(NOW, NOW - 5, -3);
		expect(root.deadlineMs).toBe(NOW);
		expect(root.budget).toBe(0);
		expect(root.path).toEqual([]);
	});
});

describe("rung identity and contract legs", () => {
	test("a rung id is sha256(host:port:model) truncated to 16 hex", async () => {
		const { createHash } = await import("node:crypto");
		expect(rungIdOf("huba", 80, MODEL)).toBe(
			createHash("sha256")
				.update(`huba:80:${MODEL}`)
				.digest("hex")
				.slice(0, 16),
		);
	});
	test("fleet legs carry the contract; provider egress stays contract-less", () => {
		const leg: Deployment = {
			group: MODEL,
			url: "http://peer",
			dialect: "openai",
		};
		expect(isContractHop({ ...leg, buckle: true })).toBe(true);
		expect(
			isContractHop({ ...leg, adapter_config: { proxy_kind: "litellm" } }),
		).toBe(true);
		expect(isContractHop(leg)).toBe(false);
	});
});

type CellFetch = (req: Request) => Promise<Response>;

/** Two loopback sockets with swappable app fetches: the mutual-dep
 *  bootstrap for the cycle test (each hub needs the other's port first).
 *  An unassigned cell answers 503. */
function cellPair(): {
	portA: number;
	portB: number;
	setA: (f: CellFetch) => void;
	setB: (f: CellFetch) => void;
	stop: () => void;
} {
	const cells: { a: CellFetch | null; b: CellFetch | null } = {
		a: null,
		b: null,
	};
	const fallback = () => new Response(null, { status: 503 });
	const srvA = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => cells.a?.(req) ?? fallback(),
	});
	const srvB = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req) => cells.b?.(req) ?? fallback(),
	});
	return {
		portA: srvA.port,
		portB: srvB.port,
		setA: (f) => {
			cells.a = f;
		},
		setB: (f) => {
			cells.b = f;
		},
		stop: () => {
			srvA.stop(true);
			srvB.stop(true);
		},
	};
}

describe("A→B→A cycle (real sockets)", () => {
	test("refuses typed at the revisited hop; provider never reached", async () => {
		const provider = await startMockUpstream(() =>
			Response.json({
				id: "1",
				choices: [],
				usage: { prompt_tokens: 1, completion_tokens: 1 },
			}),
		);
		const pair = cellPair();
		const hubA = await hub("hubA", [
			{
				group: MODEL,
				url: `http://127.0.0.1:${String(pair.portB)}`,
				dialect: "openai",
				buckle: true,
			},
		]);
		pair.setA(hubA.app.fetch);
		const hubB = await hub("hubB", [
			{
				group: MODEL,
				url: `http://127.0.0.1:${String(pair.portA)}`,
				dialect: "openai",
				buckle: true,
			},
			{
				group: MODEL,
				url: provider.url,
				dialect: "openai",
			},
		]);
		pair.setB(hubB.app.fetch);
		const res = await hubA.app.fetch(
			new Request(
				`http://127.0.0.1:${String(pair.portA)}/v1/chat/completions`,
				{
					method: "POST",
					body: JSON.stringify({ model: MODEL, stream: false }),
				},
			),
		);
		// the revisited hop (hubA) typed the refusal; hubB's provider leg in
		// the same tier was never tried — the tier exhausted, no detour
		expect(res.status).toBe(502);
		expect(
			hubA.ledger
				.auditRows()
				.some((r) => r.error_code === "hop_contract_repeated_rung"),
		).toBe(true);
		expect(provider.calls).toHaveLength(0);
		pair.stop();
		provider.close();
	}, 20000);
});

describe("peer refusal verdicts over real sockets", () => {
	test("a root budget of 1 sends budget 0 downstream; the next hop refuses 429", async () => {
		const provider = await startMockUpstream(() => Response.json({ id: "1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
		const hubB = await hub("hubB", [{ group: MODEL, url: provider.url, dialect: "openai" }]);
		const srvB = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubB.app.fetch });
		const hubA = await hub("hubA", [{ group: MODEL, url: `http://127.0.0.1:${String(srvB.port)}`, dialect: "openai", buckle: true }], { policy: { hop_contract_root_budget: 1 } });
		const srvA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubA.app.fetch });
		const res = await hubA.app.fetch(new Request(`http://127.0.0.1:${String(srvA.port)}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: MODEL, stream: false }) }));
		expect(res.status).toBe(429);
		expect(hubB.ledger.auditRows().some((r) => r.error_code === "hop_contract_budget_exhausted")).toBe(true);
		expect(provider.calls).toHaveLength(0);
		srvA.stop(true);
		srvB.stop(true);
		provider.close();
	}, 20000);
	test("an expired inbound contract 504s at admission before routing", async () => {
		const provider = await startMockUpstream(() => Response.json({ id: "1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
		const hubA = await hub("hubA", [{ group: MODEL, url: provider.url, dialect: "openai" }]);
		const srvA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubA.app.fetch });
		const v = encodeHopContract({ deadlineMs: Date.now() - 1, budget: 4, path: [] });
		const res = await hubA.app.fetch(new Request(`http://127.0.0.1:${String(srvA.port)}/v1/chat/completions`, { method: "POST", headers: { [HOP_CONTRACT_HEADER]: v }, body: JSON.stringify({ model: MODEL, stream: false }) }));
		expect(res.status).toBe(504);
		expect(hubA.ledger.auditRows().some((r) => r.error_code === "hop_contract_expired")).toBe(true);
		expect(provider.calls).toHaveLength(0);
		srvA.stop(true);
		provider.close();
	}, 20000);
});

describe("deadline clamp (real socket)", () => {
	test("an inbound contract deadline clamps the walk; the 800ms provider misses it", async () => {
		const provider = await startMockUpstream(async () => {
			await new Promise((r) => setTimeout(r, 800));
			return Response.json({ id: "1", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
		});
		const hubA = await hub("hubA", [{ group: MODEL, url: provider.url, dialect: "openai" }]);
		const srvA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubA.app.fetch });
		const v = encodeHopContract({ deadlineMs: Date.now() + 400, budget: 4, path: [] });
		const t0 = Date.now();
		const res = await hubA.app.fetch(new Request(`http://127.0.0.1:${String(srvA.port)}/v1/chat/completions`, { method: "POST", headers: { [HOP_CONTRACT_HEADER]: v }, body: JSON.stringify({ model: MODEL, stream: false }) }));
		const elapsed = Date.now() - t0;
		expect(res.ok).toBe(false);
		expect(elapsed).toBeLessThan(2500);
		expect(provider.calls.length).toBeGreaterThan(0);
		srvA.stop(true);
		provider.close();
	}, 20000);
});

describe("two hops to a provider (real sockets)", () => {
	test("one trace, one ladder, contract-less provider egress", async () => {
		const provider = await startMockUpstream(() => Response.json({ id: "1", choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
		const hubB = await hub("hubB", [{ group: MODEL, url: provider.url, dialect: "openai" }]);
		const srvB = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubB.app.fetch });
		const hubA = await hub("hubA", [{ group: MODEL, url: `http://127.0.0.1:${String(srvB.port)}`, dialect: "openai", buckle: true }]);
		const srvA = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: hubA.app.fetch });
		const res = await hubA.app.fetch(new Request(`http://127.0.0.1:${String(srvA.port)}/v1/chat/completions`, { method: "POST", body: JSON.stringify({ model: MODEL, stream: false }) }));
		expect(res.status).toBe(200);
		expect(provider.calls).toHaveLength(1);
		expect(provider.calls[0]?.headers.get(HOP_CONTRACT_HEADER)).toBeNull();
		const tp = provider.calls[0]?.headers.get("traceparent");
		expect(tp).toBeTruthy();
		const rows = [...hubA.ledger.auditRows(), ...hubB.ledger.auditRows()];
		expect(rows.length).toBeGreaterThan(0);
		const traces = new Set(rows.map((r) => r.trace_id));
		expect(traces.size).toBe(1);
		const trace = [...traces][0];
		expect(trace).toMatch(/^[0-9a-f]{32}$/);
		expect(tp?.split("-")[1]).toBe(trace);
		srvA.stop(true);
		srvB.stop(true);
		provider.close();
	}, 20000);
});
