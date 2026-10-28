// e2e/consult-contrastive.spec.ts — W2184 re-land of W927's consult-v2:
// the contrastive consult pool through the REAL coord CLI. Selection
// contract asserted pure; pool behavior through an anthropic-wire stub
// server at the gated Buckle front (async spawn — a stub can't answer
// spawnSync). Covers: happy path (k=2), refused pool, dead-leg and
// compose-fail inheritance, domain grouping, and the reply's flags.
import { expect, test } from "@playwright/test";
import {
	assignIds,
	composePrompt,
	domainVisible,
	parseCompose,
} from "../hooks/lib/contrastive-selection.ts";
import {
	cleanup,
	initProject,
	makeStub,
	run,
	seedSession,
	sqlGet,
} from "./contrastive-helpers.ts";

const ASKER = "asker-sess-22222222";
const EXPERT = "expert-sess-11111111";

const COMPOSE = [
	"PICK: A",
	"WHY: names the concrete command",
	"CUE: stale lease queues",
	"LESSON: release then re-take",
	"EVIDENCE: consult.ts:1",
	"CONFIDENCE: high",
].join("\n");

test.beforeAll(async () => {
	await initProject();
	// first child run migrates the fresh store so seedSession has its tables
	await run(["state", "--as", "w2184-warm"]);
});

test.afterAll(async () => {
	cleanup();
});

const buckleEnv = (url) => ({
	SUSPENDERS_BUCKLE_URL: url,
	SUSPENDERS_BUCKLE_TOKEN: "bksk_test",
});

const consultRow = async (id) =>
	sqlGet(
		"SELECT state, answer, expert_sid, legs, domain FROM consults WHERE id = ?",
		id,
	);

const eventOf = async (cid) => {
	const row = await sqlGet(
		"SELECT payload FROM events WHERE kind = 'consult.answer' AND json_extract(payload, '$.consult') = ? ORDER BY id DESC LIMIT 1",
		cid,
	);
	return row?.payload;
};

const kbRow = async (cid) =>
	sqlGet(
		"SELECT cue, lesson, evidence, confidence, domain, confidence_stamp FROM consult_kb WHERE consult_id = ?",
		cid,
	);

const legsOf = async (id) => {
	const row = await consultRow(id);
	return JSON.parse(row?.legs ?? "{}");
};

const cidOf = (out) => Number(out.match(/C(\d+) contrastive pick/)?.[1]);

test("selection contract: labels, blindness, parse, domain law", {
	tag: "@e2e",
}, async () => {
	expect([...assignIds(42, 3)].sort()).toEqual(["A", "B", "C"]);
	expect(assignIds(42, 3)).toEqual(assignIds(42, 3));
	expect([...assignIds(1, 4)].sort()).toEqual(["A", "B", "C", "D"]);
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
		"ms",
		"tokens",
	])
		expect(prompt.includes(tok)).toBe(false);
	const block = COMPOSE.replace("PICK: A", "PICK: B");
	const parsed = parseCompose(block, ["A", "B", "C"]);
	expect(parsed?.pick).toBe("B");
	expect(parsed?.confidence).toBe("high");
	expect(parseCompose("PICK: Z", ["A", "B"])).toBeNull();
	expect(
		parseCompose(block.replace("WHY:", "REASONING:"), ["A", "B"]),
	).toBeNull();
	expect(domainVisible(null, null)).toBe(true);
	expect(domainVisible(null, "alpha")).toBe(true);
	expect(domainVisible("alpha", "alpha")).toBe(true);
	expect(domainVisible("alpha", "beta")).toBe(false);
	expect(domainVisible("alpha", null)).toBe(false);
	expect(domainVisible("", "beta")).toBe(true);
});

test("happy path: k=2 pool, compose picks, kb + event", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	const stub = await makeStub([
		"release the lease then re-take it with the same sid",
		"release the lease then re-take it with the same sid",
		COMPOSE,
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
		buckleEnv(stub.url),
	);
	expect(r.code, r.err).toBe(0);
	expect(r.out).toContain("contrastive pick");
	const cid = cidOf(r.out);
	expect(cid).toBeGreaterThan(0);
	const legs = await legsOf(cid);
	expect(legs.legs).toHaveLength(2);
	expect(legs.labels[legs.pick]).toBeTruthy();
	expect(legs.winner).toBe(legs.labels[legs.pick]);
	const ev = await eventOf(`C${cid}`);
	expect(ev).toBeTruthy();
	for (const tok of ["reason", "coder", "cloud", "danish"])
		expect(ev?.includes(tok)).toBe(false);
	const payload = JSON.parse(ev ?? "{}");
	expect(payload.state).toBe("ANSWERED");
	expect(payload.pick).toBe(legs.pick);
	const kb = await kbRow(cid);
	expect(kb?.lesson).toBe("release then re-take");
	expect(kb?.confidence).toBe(0.7);
	expect(kb?.evidence).toBe("consult.ts:1");
	stub.stop();
});

test("refused: row REFUSED + event carries the consult id", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	const r = await run([
		"consult",
		"--contrastive",
		"why did the lease expire?",
		"--as",
		ASKER,
	]);
	expect(r.code).toBe(2);
	expect(r.err).toContain("contrastive pool refused");
	const cid = Number(r.err.match(/C(\d+)/)?.[1] ?? 0);
	expect(cid).toBeGreaterThan(0);
	expect((await consultRow(cid))?.state).toBe("REFUSED");
	const ev = await eventOf(`C${cid}`);
	expect(ev).toBeTruthy();
	const payload = JSON.parse(ev ?? "{}");
	expect(payload.state).toBe("REFUSED");
	expect(payload.reason).toBeTruthy();
});

test("dead leg: inherits the default final, pool stays k", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	const compose = COMPOSE.replace("CONFIDENCE: high", "CONFIDENCE: medium");
	const stub = await makeStub(
		["pin SUSPENDERS_LANE_MAX_ATTEMPTS to unblock", compose],
		"coder",
	);
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
		buckleEnv(stub.url),
	);
	expect(r.code, r.err).toBe(0);
	const cid = cidOf(r.out);
	expect(cid).toBeGreaterThan(0);
	const legs = await legsOf(cid);
	expect(legs.legs).toHaveLength(2);
	const coder = legs.legs.find((l) => l.leg === "coder");
	expect(coder?.inherited).toBe(true);
	expect(coder?.error).toBeTruthy();
	expect(legs.compose.inherited).toBeUndefined();
	stub.stop();
});

test("compose fail: inherits default label at low confidence", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	const stub = await makeStub(["leg A: pin the knob", "leg answers differ"]);
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
		buckleEnv(stub.url),
	);
	expect(r.code, r.err).toBe(0);
	const cid = cidOf(r.out);
	expect(cid).toBeGreaterThan(0);
	const legs = await legsOf(cid);
	expect(legs.compose.inherited).toBe(true);
	expect(legs.labels[legs.pick]).toBe("reason");
	const payload = JSON.parse((await eventOf(`C${cid}`)) ?? "{}");
	expect(payload.confidence).toBe("low");
	stub.stop();
});

test("domain grouping: alpha hits, beta + domainless miss", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	await seedSession(EXPERT);
	const stub = await makeStub([
		"re-arm via the fleet-loop maintenance task cadence",
		"re-arm via the fleet-loop maintenance task cadence",
		COMPOSE.replace(
			"EVIDENCE: consult.ts:1",
			"EVIDENCE: fleet-loop/maintenance.ts:1",
		),
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
		buckleEnv(stub.url),
	);
	expect(r.code, r.err).toBe(0);
	const dCid = cidOf(r.out);
	expect(dCid).toBeGreaterThan(0);
	// asker feedback resolves the candidate (W142: trust version must match;
	// the run() helper pins --version test-version)
	const fb = await run([
		"consult-reply",
		`C${dCid}`,
		"--feedback",
		"resolved",
		"--evidence",
		"watchdog re-armed",
		"--as",
		ASKER,
	]);
	expect(fb.code).toBe(0);
	// same-domain re-ask: the kb answers WITHOUT any leg firing
	const same = await run(
		[
			"consult",
			EXPERT,
			"--domain",
			"alpha",
			"how do I re-arm a dispatch watchdog?",
			"--as",
			ASKER,
		],
		buckleEnv("http://127.0.0.1:1/"),
	);
	expect(same.code, same.err).toBe(0);
	expect(same.out).toContain("answered from the knowledge base");
	// another domain and no-domain consumers never see the alpha row
	const other = await run(
		[
			"consult",
			EXPERT,
			"how do I re-arm a dispatch watchdog?",
			"--domain",
			"beta",
			"--as",
			ASKER,
		],
		buckleEnv("http://127.0.0.1:1/"),
	);
	expect(other.out).toContain("CONSULT");
	const otherCid = Number(other.out.match(/C(\d+)/)?.[1]);
	const openBeta = await consultRow(otherCid);
	expect(openBeta?.state).toBe("OPEN");
	expect(openBeta?.domain).toBe("beta");
	const plain = await run(
		["consult", EXPERT, "how do I re-arm a dispatch watchdog?", "--as", ASKER],
		buckleEnv("http://127.0.0.1:1/"),
	);
	const plainCid = Number(plain.out.match(/C(\d+)/)?.[1]);
	const openPlain = await consultRow(plainCid);
	expect(openPlain?.state).toBe("OPEN");
	expect(openPlain?.domain).toBeNull();
	expect((await kbRow(dCid))?.domain).toBe("alpha");
	stub.stop();
});

test("reply: experience flags stamp the kb columns", {
	tag: "@e2e",
}, async () => {
	await initProject();
	await seedSession(ASKER);
	await seedSession(EXPERT);
	const q = await run([
		"consult",
		EXPERT,
		"how do I read the W776 attribution table?",
		"--as",
		ASKER,
	]);
	expect(q.code, q.err).toBe(0);
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
	expect(rep.code, rep.err).toBe(0);
	const rkb = await kbRow(rCid);
	expect(rkb?.cue).toBe("W776 table questions");
	expect(rkb?.lesson).toBe("read the event payload");
	expect(rkb?.evidence).toBe("hooks/lib/work-report.ts:1");
	expect(rkb?.confidence).toBe(0.7);
	expect(rkb?.domain).toBe("reporting");
});
