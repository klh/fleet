// test/kev.test.ts — W225 kev-class typed-decision client: request shape
// matches the live systemone contract, options map to criteria, and every
// failure mode (down, malformed, <2 options, answer outside the option set)
// degrades to null so callers fall through to their chat chain. The URL
// resolver honors SUSPENDERS_KEV_URL.
import { afterEach, describe, expect, test } from "bun:test";
import {
	type KevDecision,
	kevProbabilityLines,
	kevTypedDecision,
	kevUrl,
} from "../hooks/lib/kev.ts";

const KEV_BODY = {
	model: "kev-latest",
	answers: {
		d: {
			type: "choice",
			choice: "merge",
			confidence: 0.62,
			probabilities: { merge: 0.62, hold: 0.38 },
		},
	},
	usage: { input_tokens: 71, output_tokens: 54 },
	latency_ms: 39_834,
};

type Called = { url: string; body: Record<string, unknown> };
let calls: Called[] = [];

const realFetch = global.fetch;

function stubFetch(
	impl: (url: string, body: Record<string, unknown>) => Response,
): void {
	global.fetch = (async (url: string | URL, init?: RequestInit) => {
		const body = init?.body ? JSON.parse(init.body as string) : {};
		return impl(String(url), body);
	}) as typeof fetch;
	calls = [];
}

function lastCall(): Called {
	return calls[calls.length - 1];
}

afterEach(() => {
	global.fetch = realFetch;
});

const OPTS = [
	{ label: "merge", tradeoff: "land the wave now" },
	{ label: "hold", tradeoff: null },
];

describe("kevUrl", () => {
	test("default is the same-box launchd service", () => {
		delete process.env.SUSPENDERS_KEV_URL;
		expect(kevUrl()).toBe("http://127.0.0.1:8912");
	});

	test("SUSPENDERS_KEV_URL overrides (the class is the protocol, not the box)", () => {
		process.env.SUSPENDERS_KEV_URL = "http://nas.threads.dk:8912/";
		expect(kevUrl()).toBe("http://nas.threads.dk:8912");
		delete process.env.SUSPENDERS_KEV_URL;
	});
});

describe("kevTypedDecision request shape", () => {
	test("posts one choice question; options map to criteria; answer maps back", async () => {
		stubFetch((url, body) => {
			calls.push({ url, body });
			return Response.json(KEV_BODY);
		});
		const d = await kevTypedDecision({
			state: "fleet context",
			question: "Pick an option.",
			options: OPTS,
		});
		const dec = d as KevDecision;
		expect(dec.choice).toBe("merge");
		expect(dec.confidence).toBe(0.62);
		expect(dec.probabilities).toEqual({ merge: 0.62, hold: 0.38 });
		expect(dec.inputTokens).toBe(71);
		expect(dec.outputTokens).toBe(54);
	});
});

describe("kevTypedDecision degradation", () => {
	test("criteria fall back to labels; empty tradeoff ignored", async () => {
		stubFetch((url, body) => {
			calls.push({ url, body });
			return Response.json(KEV_BODY);
		});
		const d = await kevTypedDecision({
			state: "s",
			question: "q",
			options: [{ label: "a" }, { label: "b", tradeoff: "" }],
		});
		expect(d).not.toBeNull();
		expect(lastCall().body.questions.d.criteria).toEqual({ a: "a", b: "b" });
	});

	test("fewer than two usable options = no call at all", async () => {
		stubFetch(() => Response.json(KEV_BODY));
		const d = await kevTypedDecision({
			state: "s",
			question: "q",
			options: [{ label: "only" }],
		});
		expect(d).toBeNull();
		expect(calls.length).toBe(0);
	});
});

describe("kevTypedDecision failure modes", () => {
	test("down, malformed, and off-option answers all return null", async () => {
		stubFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const ok = [{ label: "a" }, { label: "b" }];
		expect(
			await kevTypedDecision({ state: "s", question: "q", options: ok }),
		).toBeNull();

		stubFetch(() => Response.json({ answers: { d: {} } }));
		expect(
			await kevTypedDecision({ state: "s", question: "q", options: ok }),
		).toBeNull();

		stubFetch(() =>
			Response.json({
				answers: { d: { choice: "ghost", probabilities: { a: 1 } } },
			}),
		);
		expect(
			await kevTypedDecision({ state: "s", question: "q", options: ok }),
		).toBeNull();
	});
});

describe("kevProbabilityLines", () => {
	test("sorts best-first with rounded percentages", () => {
		const d: KevDecision = {
			model: "m",
			choice: "b",
			confidence: 0.7,
			probabilities: { a: 0.3, b: 0.7 },
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 0,
		};
		expect(kevProbabilityLines(d)).toEqual(["b 70%", "a 30%"]);
	});
});
