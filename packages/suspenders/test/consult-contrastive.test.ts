// consult-contrastive.test.ts — W927 consult-v2: the contrastive consult
// pool. Covers: seeded anonymized labels (assignIds), the identity-blind
// compose prompt (no leg name/model/spend can enter), parseCompose's
// contract, domain grouping visibility, and e2e through the real CLI with a
// local wire stub (async spawn — a Bun.serve stub can't answer spawnSync,
// W362): happy path, refused pool (event carries the consult id), dead-leg
// inheritance (STAGE_ATTEMPTS=2), compose-fail inheritance, experience
// fields on kb rows, and the reply's experience flags.
import { describe, test, expect, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import {
	assignIds,
	composePrompt,
	parseCompose,
	domainVisible,
} from "../hooks/lib/contrastive-selection.ts";

const HOME = mkdtempSync(join(tmpdir(), "suspenders-cv2-"));
const REPO = mkdtempSync(join(tmpdir(), "suspenders-cv2-repo-"));
mkdirSync(join(REPO, ".git"), { recursive: true });
const coord = join(import.meta.dir, "..", "hooks", "bin", "coord.ts");
const DB = join(HOME, ".cache", "claude-governor", "governor.db");
mkdirSync(join(HOME, ".cache", "claude-governor"), { recursive: true });
const ASKER = "asker-sess-22222222";
const EXPERT = "expert-sess-11111111";
// pin every operator knob the legs read — ambient env must not leak in
const BASE_ENV: Record<string, string> = {
	ORACLE_ROUTE_URL: "",
	ORACLE_ROUTE_KEY: "",
	ORACLE_ROUTE_MODEL: "",
	ORACLE_CODER_URL: "",
	ORACLE_CODER_KEY: "",
	ORACLE_DANISH_URL: "",
	ORACLE_DANISH_KEY: "",
	BELT_ESCALATE_URL: "",
	BELT_ESCALATE_KEY: "",
};

function projectOf(dir: string): string {
	const r = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--git-common-dir"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode === 0) {
		const d = new TextDecoder().decode(r.stdout).trim();
		if (d) return realpathSync(resolve(dir, d));
	}
	return realpathSync(dir);
}
const PROJ = projectOf(REPO);
function seedSession(sid: string) {
	const db = new Database(DB);
	db.query(
		"INSERT OR REPLACE INTO sessions (sid, project, started_at, hb, state) VALUES (?, ?, ?, ?, 'RUNNING')",
	).run(sid, PROJ, Date.now(), Date.now());
	db.close();
}

// async spawn — the in-process stub cannot serve a spawnSync child (W362);
// child pipes are ReadableStreams → new Response(pipe).text()
async function run(args: string[], extraEnv: Record<string, string> = {}) {
	const env = { ...process.env, HOME, ...BASE_ENV, ...extraEnv };
	const p = Bun.spawn(
		[
			"bun",
			coord,
			...args,
			"--version",
			"test-version",
			...(args[0] === "consult" ? ["--scope", "hooks/leases"] : []),
		],
		{ cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
	);
	const [out, err] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
	]);
	return { out, err, code: await p.exited };
}
function consultRow(id: number) {
	const db = new Database(DB, { readonly: true });
	const r = db
		.query(
			"SELECT state, answer, expert_sid, legs, domain FROM consults WHERE id = ?",
		)
		.get(id) as
		| {
				state: string;
				answer: string | null;
				expert_sid: string;
				legs: string | null;
				domain: string | null;
		  }
		| undefined;
	db.close();
	return r;
}

function eventOf(cid: string) {
	const db = new Database(DB, { readonly: true });
	const ev = db
		.query(
			"SELECT payload FROM events WHERE kind = 'consult.answer' AND json_extract(payload, '$.consult') = ? ORDER BY id DESC LIMIT 1",
		)
		.get(cid) as { payload: string } | undefined;
	db.close();
	return ev?.payload;
}
function makeStub(script: string[]): { url: string; stop: () => void } {
	let n = 0;
	const server = Bun.serve({
		port: 0,
		fetch: (req) => {
			const u = new URL(req.url);
			if (u.pathname.endsWith("/models"))
				return Response.json({ data: [{ id: "stub-model" }] });
			const content = script[n] ?? "stub overflow answer";
			n++;
			return Response.json({
				choices: [{ message: { content } }],
				usage: { prompt_tokens: 10, completion_tokens: 20 },
			});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1/chat/completions`,
		stop: () => server.stop(true),
	};
}
describe("W927 selection", () => {
	test("assignIds: seeded, deterministic, label permutation", () => {
		expect(assignIds(42, 3)).toEqual(assignIds(42, 3));
		expect([...assignIds(42, 3)].sort()).toEqual(["A", "B", "C"]);
		expect([...assignIds(43, 3)].sort()).toEqual(["A", "B", "C"]);
		expect([...assignIds(1, 4)].sort()).toEqual(["A", "B", "C", "D"]);
	});

	test("composePrompt is identity-blind: no leg name, model, port or spend", () => {
		const prompt = composePrompt("q?", [
			{ label: "A", text: "candidate A text" },
			{ label: "B", text: "candidate B text" },
		]);
		for (const tok of [
			"reason",
			"coder",
			"cloud",
			"danish",
			":8901",
			":8903",
			":8906",
			"glm",
			"GLM",
			"ms",
			"tokens",
		])
			expect(prompt.includes(tok)).toBe(false);
		expect(prompt).toContain("[A]");
		expect(prompt).toContain("candidate A text");
	});
	test("parseCompose: full block parses; foreign/missing label refuses", () => {
		const block = [
			"PICK: B",
			"WHY: names the concrete command",
			"CUE: stale lease queues",
			"LESSON: release then re-take",
			"EVIDENCE: hooks/coord/consult.ts:1",
			"CONFIDENCE: high",
		].join("\n");
		const parsed = parseCompose(block, ["A", "B", "C"]);
		expect(parsed?.pick).toBe("B");
		expect(parsed?.confidence).toBe("high");
		expect(parsed?.lesson).toBe("release then re-take");
		expect(parseCompose("PICK: Z", ["A", "B"])).toBeNull();
		expect(
			parseCompose(
				block.replace("WHY:", "REASONING:"),
				["A", "B"],
			),
		).toBeNull();
	});

	test("domainVisible: the grouping law", () => {
		expect(domainVisible(null, null)).toBe(true);
		expect(domainVisible(null, "alpha")).toBe(true);
		expect(domainVisible("alpha", "alpha")).toBe(true);
		expect(domainVisible("alpha", "beta")).toBe(false);
		expect(domainVisible("alpha", null)).toBe(false);
		expect(domainVisible("", "beta")).toBe(true);
	});
});
function kbRow(id: number) {
	const db = new Database(DB, { readonly: true });
	const r = db
		.query(
			"SELECT cue, lesson, evidence, confidence, domain FROM consult_kb WHERE consult_id = ?",
		)
		.get(id) as
		| {
				cue: string | null;
				lesson: string | null;
				evidence: string | null;
				confidence: string | null;
				domain: string | null;
		  }
		| undefined;
	db.close();
	return r;
}
function legsOf(id: number) {
	return JSON.parse(consultRow(id)?.legs ?? "{}") as {
		labels: Record<string, string>;
		pick: string | null;
		winner: string;
		compose: { model: string; ms: number; inherited?: boolean };
		legs: { leg: string; inherited: boolean; error?: string }[];
	};
}
describe("W927 e2e — the contrastive pool through the real CLI", () => {
	beforeAll(async () => {
		// first child run migrates the fresh store; later seedSession INSERTs
		// need the sessions table
		await run(["state", "--as", "w927-warm"]);
	});
	test("happy: k=2 pool, compose, kb + event", async () => {
		seedSession(ASKER);
		seedSession(EXPERT);
		const compose = [
			"PICK: A",
			"WHY: names the concrete re-take command",
			"CUE: stale lease queues",
			"LESSON: release then re-take",
			"EVIDENCE: consult.ts:1",
			"CONFIDENCE: high",
		].join("\n");
		const stub = makeStub([
			"release the lease then re-take it with the same sid",
			"release the lease then re-take it with the same sid",
			compose,
		]);
		const r = await run(
			[
				"consult",
				"--contrastive",
				"--k",
				"2",
				"how do I clear a stuck lane lease?",
				"--as",
				ASKER,
			],
			{
				ORACLE_ROUTE_URL: stub.url,
				ORACLE_CODER_URL: stub.url,
			},
		);
		expect(r.code, r.err).toBe(0);
		expect(r.out).toContain("contrastive pick");
		const cid = Number(r.out.match(/C(\d+) contrastive pick/)?.[1]);
		expect(cid).toBeGreaterThan(0);
		const legs = legsOf(cid);
		expect(legs.legs).toHaveLength(2);
		expect(legs.labels[legs.pick ?? ""]).toBeTruthy();
		expect(legs.winner).toBe(legs.labels[legs.pick ?? ""]);
		const ev = eventOf(`C${cid}`);
		expect(ev).toBeTruthy();
		// identity-blind surfaces: the consult.answer event carries pick + kb,
		// never the leg names — the mapping lives on the consults row only
		for (const tok of ["reason", "coder", "cloud", "danish"])
			expect(ev?.includes(tok)).toBe(false);
		const payload = JSON.parse(ev ?? "{}") as {
			state: string;
			pick: string;
		};
		expect(payload.state).toBe("ANSWERED");
		expect(payload.pick).toBe(legs.pick);
		const kb = kbRow(cid);
		expect(kb?.lesson).toBe("release then re-take");
		expect(kb?.confidence).toBe("high");
		expect(kb?.evidence).toBe("consult.ts:1");
		stub.stop();
	});
	test("refused: row REFUSED + event carries the consult id", async () => {
		seedSession(ASKER);
		const r = await run(
			[
				"consult",
				"--contrastive",
				"why did the lease expire?",
				"--as",
				ASKER,
			],
		);
		expect(r.code).toBe(2);
		expect(r.err).toContain("contrastive pool refused");
		const cid = Number(r.err.match(/C(\d+)/)?.[1] ?? 0);
		expect(cid).toBeGreaterThan(0);
		expect(consultRow(cid)?.state).toBe("REFUSED");
		const ev = eventOf(`C${cid}`);
		expect(ev).toBeTruthy();
		const payload = JSON.parse(ev ?? "{}") as {
			state: string;
			reason: string;
		};
		expect(payload.state).toBe("REFUSED");
		expect(payload.reason).toBeTruthy();
	});
	test("dead leg: inherits the default final, pool stays k", async () => {
		seedSession(ASKER);
		const compose = [
			"PICK: A",
			"WHY: the default leg answered concretely",
			"CUE: quarantine questions",
			"LESSON: pin the attempt knob",
			"EVIDENCE: lane.ts:1",
			"CONFIDENCE: medium",
		].join("\n");
		const stub = makeStub([
			"pin SUSPENDERS_LANE_MAX_ATTEMPTS to unblock",
			compose,
		]);
		const r = await run(
			[
				"consult",
				"--contrastive",
				"--k",
				"2",
				"how do I unblock a budget-quarantined READY item?",
				"--as",
				ASKER,
			],
			{
				ORACLE_ROUTE_URL: stub.url,
				ORACLE_CODER_URL: "http://127.0.0.1:1/v1/chat/completions",
			},
		);
		expect(r.code).toBe(0);
		const cid = Number(r.out.match(/C(\d+) contrastive pick/)?.[1]);
		expect(cid).toBeGreaterThan(0);
		const legs = legsOf(cid);
		expect(legs.legs).toHaveLength(2);
		const coder = legs.legs.find((l) => l.leg === "coder");
		expect(coder?.inherited).toBe(true);
		expect(coder?.error).toBeTruthy();
		expect(legs.compose.inherited).toBeUndefined();
		stub.stop();
	});
	test("compose fail: inherits default label at low confidence", async () => {
		seedSession(ASKER);
		const stub = makeStub([
			"leg A: pin the knob",
			"leg answers differ",
		]);
		const r = await run(
			[
				"consult",
				"--contrastive",
				"--k",
				"2",
				"which knob unblocks a quarantined READY item?",
				"--as",
				ASKER,
			],
			{
				ORACLE_ROUTE_URL: stub.url,
				ORACLE_CODER_URL: stub.url,
			},
		);
		expect(r.code).toBe(0);
		const cid = Number(r.out.match(/C(\d+) contrastive pick/)?.[1]);
		expect(cid).toBeGreaterThan(0);
		const legs = legsOf(cid);
		expect(legs.compose.inherited).toBe(true);
		expect(legs.labels[legs.pick ?? ""]).toBe("reason");
		const payload = JSON.parse(eventOf(`C${cid}`) ?? "{}") as {
			confidence: string;
		};
		expect(payload.confidence).toBe("low");
		stub.stop();
	});
	test("domain grouping: alpha hits, beta + domainless miss", async () => {
		seedSession(ASKER);
		seedSession(EXPERT);
		const compose = [
			"PICK: A",
			"WHY: actionable",
			"CUE: watchdog questions",
			"LESSON: re-arm via fleet-loop task cadence",
			"EVIDENCE: fleet-loop/maintenance.ts:1",
			"CONFIDENCE: medium",
		].join("\n");
		const stub = makeStub([
			"re-arm via the fleet-loop maintenance task cadence",
			"re-arm via the fleet-loop maintenance task cadence",
			compose,
		]);
		const r = await run(
			[
				"consult",
				"--contrastive",
				"--domain",
				"alpha",
				"how do I re-arm a dispatch watchdog?",
				"--as",
				ASKER,
			],
			{
				ORACLE_ROUTE_URL: stub.url,
				ORACLE_CODER_URL: stub.url,
			},
		);
		expect(r.code).toBe(0);
		const dCid = Number(r.out.match(/C(\d+) contrastive pick/)?.[1]);
		expect(dCid).toBeGreaterThan(0);
		// asker feedback resolves the candidate (W142: reuse only after resolve)
		const fb = await run([
			"consult-reply",
			`C${dCid}`,
			"--feedback",
			"resolved",
			"--evidence",
			"watchdog re-armed",
			"--version",
			"test-version",
			"--as",
			ASKER,
		]);
		expect(fb.code).toBe(0);
		// same-domain re-ask: the kb answers WITHOUT any leg firing
		const same = await run([
			"consult",
			EXPERT,
			"--domain",
			"alpha",
			"how do I re-arm a dispatch watchdog?",
			"--as",
			ASKER,
		]);
		expect(same.code, same.err).toBe(0);
		expect(same.out).toContain("answered from the knowledge base");
		// another domain and no-domain consumers never see the alpha row
		const other = await run([
			"consult",
			EXPERT,
			"how do I re-arm a dispatch watchdog?",
			"--domain",
			"beta",
			"--as",
			ASKER,
		]);
		const otherCid = Number(other.out.match(/C(\d+)/)?.[1]);
		expect(other.out).toContain("CONSULT");
		const openBeta = consultRow(otherCid);
		expect(openBeta?.state).toBe("OPEN");
		expect(openBeta?.domain).toBe("beta");
		const plain = await run([
			"consult",
			EXPERT,
			"how do I re-arm a dispatch watchdog?",
			"--as",
			ASKER,
		]);
		const plainCid = Number(plain.out.match(/C(\d+)/)?.[1]);
		const openPlain = consultRow(plainCid);
		expect(openPlain?.state).toBe("OPEN");
		expect(openPlain?.domain).toBeNull();
		expect(kbRow(dCid)?.domain).toBe("alpha");
		stub.stop();
	});
	test("reply: experience flags stamp the kb columns", async () => {
		seedSession(ASKER);
		seedSession(EXPERT);
		const q = await run([
			"consult",
			EXPERT,
			"how do I read the W776 attribution table?",
			"--as",
			ASKER,
		]);
		expect(q.code).toBe(0);
		const rCid = Number(q.out.match(/C(\d+)/)?.[1]);
		expect(rCid).toBeGreaterThan(0);
		const rep = await run([
			"consult-reply",
			`C${rCid}`,
			"check the work.done event payload",
			"--cue",
			"W776 table questions",
			"--lesson",
			"read the event payload",
			"--evidence",
			"hooks/lib/work-report.ts:1",
			"--confidence",
			"high",
			"--domain",
			"reporting",
			"--as",
			EXPERT,
		]);
		expect(rep.code).toBe(0);
		const rkb = kbRow(rCid);
		expect(rkb?.cue).toBe("W776 table questions");
		expect(rkb?.lesson).toBe("read the event payload");
		expect(rkb?.evidence).toBe("hooks/lib/work-report.ts:1");
		expect(rkb?.confidence).toBe("high");
		expect(rkb?.domain).toBe("reporting");
	});
	afterAll(() => {
		rmSync(HOME, { recursive: true, force: true });
		rmSync(REPO, { recursive: true, force: true });
	});
});
