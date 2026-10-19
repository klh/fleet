// test/hop-relay.test.ts — W706 hop attribution across a relay chain. A
// 3-hop relay (client → hubA → hubB → hubC → provider) bills ONCE: the
// origin hub's audit row carries hop='origin' (the designated billing
// source); relay hops mark forwarded — evidence, never billed again.
// Origin/peer ride the observations per hop.
import { describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { testDeps } from "./deps.ts";
import { createApp, type AppDeps } from "../src/handlers.ts";
import { hopBaggageOf, hopFromBaggage, hopKindOf } from "../src/hop.ts";
import { ObservationOutbox, type Observation } from "../src/observe.ts";
import type { Deployment, UpstreamPool } from "../src/upstreams.ts";
import { startMockUpstream } from "./mock.ts";

describe("hop marker helpers", () => {
	test("hopFromBaggage reads the peer key", () => {
		const hop = hopFromBaggage(
			"fleet.lane.id=autow461,fleet.origin.hub.id=hubA,fleet.peer.hub.id=hubB",
		);
		expect(hop.peer).toBe("hubB");
	});

	test("no baggage → peer null → origin hop", () => {
		expect(hopFromBaggage(null).peer).toBeNull();
		expect(hopKindOf(hopFromBaggage(undefined))).toBe("origin");
	});

	test("hopBaggageOf passes the origin through and claims the peer seat", () => {
		const out = hopBaggageOf(
			"fleet.origin.hub.id=hubA,fleet.peer.hub.id=hubA,fleet.lane.id=autow461",
			"hubB",
		);
		expect(out).toContain("fleet.origin.hub.id=hubA");
		expect(out).toContain("fleet.peer.hub.id=hubB");
		expect(out).toContain("fleet.lane.id=autow461");
	});

	test("hopBaggageOf roots the origin at self when none was received", () => {
		const out = hopBaggageOf("fleet.lane.id=autow461", "hubA");
		expect(out).toContain("fleet.origin.hub.id=hubA");
		expect(out).toContain("fleet.peer.hub.id=hubA");
	});
});

const MODEL = "glm-5.3-flash";

interface Hub {
	app: { fetch(req: Request): Promise<Response> };
	ledger: AppDeps["ledger"];
	outboxPath: string;
}

/** One relay hub: a full testDeps app; the leg to the next hub is
 *  buckle-marked (the W706 config-over-code flag), the terminal leg to the
 *  mock provider is not. Observations ride a bounded outbox, ledger memory. */
async function hub(
	hubId: string,
	next: string | null,
	providerUrl: string,
): Promise<Hub> {
	const obsPath = `/tmp/buckle-hop-${hubId}-${Date.now()}-${process.pid}.jsonl`;
	await rm(obsPath, { force: true });
	const dep: Deployment = next
		? { group: MODEL, url: next, dialect: "openai", buckle: true }
		: { group: MODEL, url: providerUrl, dialect: "openai" };
	const pool = {
		groups: () => [MODEL],
		deployments: (g: string): Deployment[] => (g === MODEL ? [dep] : []),
	} satisfies UpstreamPool;
	const deps: AppDeps = {
		...testDeps(pool),
		hubId,
		observations: new ObservationOutbox({ path: obsPath, hubId }),
	};
	return { app: createApp(deps), ledger: deps.ledger, outboxPath: obsPath };
}

/** The outbox flush is async — poll until the expected event count lands. */
async function readOutbox(path: string, atLeast: number): Promise<Observation[]> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const obs = await ObservationOutbox.read(path);
		if (obs.length >= atLeast || Date.now() > deadline) return obs;
		await new Promise((r) => setTimeout(r, 25));
	}
}

describe("3-hop relay (client → hubA → hubB → hubC → provider)", () => {
	test("bills once: origin row designated, relays mark forwarded", async () => {
		const provider = await startMockUpstream(() =>
			Response.json({
				id: "1",
				choices: [],
				usage: { prompt_tokens: 5, completion_tokens: 2 },
			}),
		);
		const hubC = await hub("hubC", null, provider.url);
		const srvC = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: hubC.app.fetch,
		});
		const hubB = await hub(
			"hubB",
			`http://127.0.0.1:${srvC.port}`,
			provider.url,
		);
		const srvB = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: hubB.app.fetch,
		});
		const hubA = await hub(
			"hubA",
			`http://127.0.0.1:${srvB.port}`,
			provider.url,
		);

		const res = await hubA.app.fetch(
			new Request("http://hubA/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: MODEL, stream: false }),
			}),
		);
		expect(res.status).toBe(200);

		// the terminal provider leg carries NO baggage (external egress strip)
		expect(provider.calls[0]?.headers.get("baggage")).toBeNull();

		// observations: origin passes through, each hop claims the peer seat
		const obsA = await readOutbox(hubA.outboxPath, 3);
		const obsB = await readOutbox(hubB.outboxPath, 3);
		const obsC = await readOutbox(hubC.outboxPath, 3);
		for (const o of obsA) expect(o.data.origin).toBe("hubA");
		expect(obsA[0]?.data.peer).toBeUndefined();
		for (const o of obsB)
			expect(o.data).toMatchObject({ origin: "hubA", peer: "hubA" });
		for (const o of obsC)
			expect(o.data).toMatchObject({ origin: "hubA", peer: "hubB" });

		// billing: exactly one designated source across the chain
		const rows = [hubA, hubB, hubC].map((h) => h.ledger.auditRows());
		expect(rows[0][0]?.hop).toBe("origin");
		expect(rows[1][0]?.hop).toBe("forwarded");
		expect(rows[2][0]?.hop).toBe("forwarded");
		const billable = rows.flat().filter((r) => r.hop === "origin");
		expect(billable).toHaveLength(1);
		// every hop served the request — usage evidence exists at each hop
		for (const r of rows) expect(r.length).toBeGreaterThan(0);

		srvB.stop(true);
		srvC.stop(true);
		provider.close();
	}, 20000);
});
