// W279 — router e-label mapping: serving-tier detectors (classifyELabel), the
// sealed e-decision replay, routedTier category-first scoring, and the shim
// end-to-end (_routing.category + cloud-first escalation) against stub
// servers only — never the live :890x fleet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyELabel,
	eLabelSpecial,
	scoreComplexity,
} from "../bin/router-core.ts";
import { loadTasks } from "../bench/arena/seal.ts";
import { routedTier } from "../bench/arena/legs.ts";
import { byPort } from "../bin/registry.ts";

const ref = (t: string) => `[ref:nonce] ${t}`;
const decide = (t: string) => classifyELabel(ref(t), scoreComplexity(ref(t)));

describe("serving-tier detectors (W279)", () => {
	test("none: image / video / audio / web / phone capability asks", () => {
		for (const t of [
			"Generate a photorealistic image of tonight's train departures.",
			"Produce a 30-second video clip of the wheelchair access.",
			"Transcribe the attached 20-minute audio recording of the keynote.",
			"Browse the live web right now and report the current status.",
			"Phone the venue and ask about the product launch keynote.",
		])
			expect(decide(t).label).toBe("none");
	});

	test("cloud: stated >32k tokens parses k and comma formats", () => {
		for (const t of [
			"Use the attached 120k-token specification to explain the retry policy.",
			"From the attached 95,000-token contract, summarise every clause.",
			"Here is our 180k-token zero-token-fill monorepo dump; find every caller.",
			"Across the attached 60k-token incident log, list each occurrence.",
		])
			expect(decide(t).label).toBe("cloud");
	});
});

describe("serving-tier detectors II (W279)", () => {
	test("cloud: frontier-model demand escalates, sub-threshold does not", () => {
		expect(decide("Use a frontier model for this one.").label).toBe("cloud");
		const small = "Summarise this 500-token brief for the team.";
		expect(eLabelSpecial(ref(small))).toBeNull();
		expect(decide(small).label).toBe("extract"); // complexity fallback
	});

	test("coder: fix/test/annotate shapes hit code verbs and nouns", () => {
		for (const t of [
			"Fix the memory leak in the worker pool shutdown path.",
			"Remove the race condition between the retry timer and the closer.",
			"Patch the failing tests in the billing suite.",
			"Add type annotations to the public API surface of the SDK.",
		])
			expect(decide(t).label).toBe("coder");
	});

	test("general: translation and named-language requests", () => {
		for (const t of [
			"Translate the welcome email into Danish.",
			"Rewrite the onboarding page in German for the Berlin launch.",
			"Render the error message in French and keep the tone formal.",
		])
			expect(decide(t).label).toBe("general");
	});

	test("reason: analysis prose without code", () => {
		for (const t of [
			"Analyze the trade-offs between the two storage engines.",
			"Work out step by step whether the cheaper plan holds up.",
			"Estimate the risks of migrating the cluster over a weekend.",
		])
			expect(decide(t).label).toBe("reason");
	});

	test("special detectors see code fences; danish stays with isDanish", () => {
		expect(eLabelSpecial(ref("```js\nconst x = 1;\n```"))?.label).toBe("coder");
		expect(eLabelSpecial(ref("Over_set det nye produkt nu.")) === null).toBe(
			true,
		);
	});
});

describe("sealed e-decision replay (W279)", () => {
	test("all 130 gold e-tasks classify to their label", () => {
		const tf = loadTasks("e");
		expect(tf.tasks.length).toBe(130);
		const misses: string[] = [];
		for (const t of tf.tasks) {
			const text = ref(t.text ?? t.prompt ?? "");
			const got = classifyELabel(text, scoreComplexity(text)).label;
			if (got !== t.label) misses.push(`${t.id}: want ${t.label} got ${got}`);
		}
		expect(misses).toEqual([]);
	});
});

describe("routedTier category-first scoring (W279)", () => {
	test("explicit category wins over port; label keys map verbatim", () => {
		expect(routedTier({ category: "cloud", port: 8903 })).toBe("cloud");
		expect(routedTier({ category: "none", port: 8903 })).toBe("none");
		expect(routedTier({ category: "general", port: 8906 })).toBe("general");
	});

	test("old-shim parity: bare ports and legacy categories still score", () => {
		expect(routedTier({ port: 8901 })).toBe("coder");
		expect(routedTier({ port: 8902 })).toBe("extract");
		expect(routedTier({ port: 8903 })).toBe("reason");
		expect(routedTier({ category: "code", port: 8901 })).toBe("coder");
		expect(routedTier({ port: 8906 })).toBe("general");
		expect(routedTier({ port: 0, model: "z.ai:glm-4.7" })).toBe("cloud");
		expect(routedTier({ port: 8970 })).toBe("local:8970");
		expect(routedTier(null)).toBeNull();
	});

	test("registry roles: 8901 code, 8902 extract, 8903 reason, 8906 general", () => {
		expect(byPort(8901)?.role).toBe("code");
		expect(byPort(8902)?.role).toBe("extract");
		expect(byPort(8903)?.role).toBe("reason");
		expect(byPort(8906)?.role).toBe("general");
	});
});

// ─── shim end-to-end: e-label rides _routing.category; cloud-first ───
let shim: ReturnType<typeof Bun.spawn> | undefined;
let shimBase = "";
let home = "";
let cloudHits = 0;
let upHits = 0;
let cloudGate: Promise<void> | null = null;

function stubServe(handlers: {
	[A: string]: (req: Request) => Response | Promise<Response>;
}) {
	return Bun.serve({
		port: 0,
		idleTimeout: 30,
		fetch(req) {
			const key = `${req.method} ${new URL(req.url).pathname}`;
			return handlers[key]?.(req) ?? new Response("not found", { status: 404 });
		},
	});
}

beforeAll(async () => {
	home = makePrefsHome();
	const { up, cloud } = await startStubs();
	const port = await freePort();
	shimBase = `http://127.0.0.1:${port}`;
	shim = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("../bin/router-shim.ts", import.meta.url).pathname,
		],
		env: {
			...process.env,
			HOME: home,
			BELT_ROUTER_PORT: String(port),
			BELT_UPSTREAM_KEY: "bksk_test-scoped-fake",
			BELT_UPSTREAM_BASE: `http://127.0.0.1:${up}`,
			BELT_RETRY_WAIT_CAP_MS: "500",
			BELT_ESCALATE_URL: `http://127.0.0.1:${cloud}`,
			BELT_ESCALATE_KEY: "bksk_test-scoped-fake",
			BELT_PORT_CAPS: "8903:1",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	for (let i = 0; i < 100; i++) {
		const live = await fetch(`${shimBase}/health/liveliness`)
			.then((r) => r.ok)
			.catch(() => false);
		if (live) return;
		await Bun.sleep(50);
	}
	throw new Error("router-shim did not come up");
});

afterAll(() => {
	shim?.kill();
	if (home) rmSync(home, { recursive: true, force: true });
});

// hoisted helpers — beforeAll above consumes them after module load
function makePrefsHome(): string {
	const h = mkdtempSync(join(tmpdir(), "w279-"));
	mkdirSync(join(h, ".claude", "local-llm"), { recursive: true });
	writeFileSync(
		join(h, ".claude", "local-llm", "prefs.json"),
		JSON.stringify({ allow_cloud: false, kev: { enabled: false } }),
	);
	return h;
}

function startStubs(): { up: number; cloud: number } {
	const up = stubServe({
		"POST /v1/chat/completions": () => {
			upHits++;
			return Response.json({
				choices: [{ message: { content: "up answer" } }],
			});
		},
	});
	const cloud = stubServe({
		"POST /v1/messages": async () => {
			cloudHits++;
			if (cloudGate) await cloudGate;
			return Response.json({
				content: [{ type: "text", text: "cloud answer" }],
			});
		},
	});
	return { up: up.port, cloud: cloud.port };
}

async function freePort(): Promise<number> {
	const s = Bun.serve({ port: 0, fetch: () => new Response("") });
	const p = s.port ?? 0;
	s.stop(true);
	return p;
}

const post = (body: Record<string, unknown>) =>
	fetch(`${shimBase}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer bksk_test-scoped-fake",
		},
		body: JSON.stringify({
			model: "glm-5.3-flash",
			max_tokens: 2048,
			temperature: 0,
			...body,
		}),
	});

const asRouting = async (r: Response) =>
	((await r.json()) as { _routing: RoutingShape })._routing;

type RoutingShape = {
	port: number;
	model?: string;
	category?: string;
	notes?: string[];
};

describe("router-shim end-to-end (W279, stub upstream)", () => {
	test("defect-fix prose keeps category coder and lands on 8901", async () => {
		const r = await post({
			messages: [
				{
					role: "user",
					content: "Fix the memory leak in the worker pool shutdown path.",
				},
			],
		});
		expect(r.status).toBe(200);
		const rt = await asRouting(r);
		expect(rt.category).toBe("coder");
		expect(rt.port).toBe(8901);
		expect(upHits).toBeGreaterThan(0);
	});

	test("analysis prose gets category reason and lands on 8903", async () => {
		const r = await post({
			messages: [
				{
					role: "user",
					content:
						"Analyze the trade-offs between the two storage engines for the archive tier.",
				},
			],
		});
		const rt = await asRouting(r);
		expect(rt.category).toBe("reason");
		expect(rt.port).toBe(8903);
	});

	test("non-text capability ask gets category none (best-effort 8903)", async () => {
		const r = await post({
			messages: [
				{
					role: "user",
					content:
						"Generate a photorealistic image of the new departures hall.",
				},
			],
		});
		const rt = await asRouting(r);
		expect(rt.category).toBe("none");
		expect(rt.port).toBe(8903);
	});

	test("120k-token ask with allow_cloud=false: category cloud, stays local", async () => {
		const before = cloudHits;
		const r = await post({
			messages: [
				{
					role: "user",
					content:
						"From the attached 120k-token specification, explain the retry policy.",
				},
			],
		});
		const rt = await asRouting(r);
		expect(rt.category).toBe("cloud");
		expect(rt.port).toBe(8903);
		expect(cloudHits).toBe(before);
	});

	test("allow_cloud=true: 120k ask escalates to the cloud stub", async () => {
		writeFileSync(
			join(home, ".claude", "local-llm", "prefs.json"),
			JSON.stringify({ allow_cloud: true, kev: { enabled: false } }),
		);
		const before = cloudHits;
		const r = await post({
			messages: [
				{
					role: "user",
					content:
						"From the attached 120k-token specification, explain the retry policy.",
				},
			],
		});
		const j = (await r.json()) as {
			_routing: RoutingShape;
			content: { type: string; text: string }[];
		};
		expect(j._routing.port).toBe(0);
		expect(j._routing.model?.startsWith("z.ai:")).toBe(true);
		expect(j._routing.category).toBe("cloud");
		expect(cloudHits).toBe(before + 1);
		expect(j.content[0]?.text).toBe("cloud answer");
	});

	test("cloud-first calls do not occupy the protected local reason slot", async () => {
		let releaseCloud = () => {};
		cloudGate = new Promise<void>((resolve) => {
			releaseCloud = resolve;
		});
		const before = cloudHits;
		const body = {
			messages: [
				{
					role: "user",
					content:
						"From the attached 120k-token specification, explain the retry policy.",
				},
			],
		};
		const first = post(body);
		for (let i = 0; i < 40 && cloudHits === before; i++) await Bun.sleep(25);
		const second = post(body);
		await Bun.sleep(100);
		releaseCloud();
		cloudGate = null;
		const results = await Promise.all([first, second]);
		expect(results.map((r) => r.status)).toEqual([200, 200]);
		expect(cloudHits).toBe(before + 2);
	});

	test("500-token ask is extract (SIMPLE), not cloud", async () => {
		const r = await post({
			messages: [
				{
					role: "user",
					content: "Summarise this 500-token brief for the team.",
				},
			],
		});
		const rt = await asRouting(r);
		expect(rt.category).toBe("extract");
		expect(rt.port).toBe(8902);
	});
});
