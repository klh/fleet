// e2e/board-launch-context.spec.ts — W1240: the task drawer's launch-context
// section against a REAL board. The textarea renders the stored dispatch
// brief VERBATIM (string equality against the stored record, no truncation,
// fully scrollable), a manual take without a brief gets the labeled item
// fields, and a capsule-less item gets the honest empty state — never a
// blank box. Rides the W1136 fixtures: startBoard scratch HOME + repo,
// OS-picked port, dead loopback upstreams.
import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startBoard, type Board } from "./harness.ts";

test.describe.configure({ mode: "serial" });

let b: Board | null = null;
let wid = ""; // item WITH a stored brief
let takeId = ""; // manual take, no brief → labeled item fields
let bareId = ""; // no claim, no description → honest empty state

const BRIEF_SID = "autow1240-e2e-lane";
const BRIEF_TAIL = "W1240-E2E-NO-TRUNCATION-TAIL-MARKER";
const BRIEF = `${"launch-context probe paragraph. ".repeat(180)}\n${BRIEF_TAIL}\n`;

function must(): Board {
	if (b === null) throw new Error("board not started");
	return b;
}

test.beforeAll(async () => {
	b = await startBoard("launch-context");
	wid = must().mintedId(
		must().workOk(
			["add", "briefed lane item", "--desc", "has a brief"],
			"mint",
		),
	);
	must().workOk(["take", wid, "--as", BRIEF_SID], "claim as the brief's sid");
	mkdirSync(join(must().MY_PROJ, ".fleet"), { recursive: true });
	writeFileSync(join(must().MY_PROJ, ".fleet", `brief-${BRIEF_SID}.md`), BRIEF);
	takeId = must().mintedId(
		must().workOk(
			["add", "manual take, no brief", "--desc", "raw field text"],
			"mint take item",
		),
	);
	must().workOk(["take", takeId, "--as", "autow1240-e2e-take"], "manual take");
	bareId = must().mintedId(
		must().workOk(["add", "capsule-less item"], "mint bare item"),
	);
});

test.afterAll(async () => {
	if (b) await b.stop();
});

test("api: the endpoint serves the stored brief verbatim", async () => {
	const r = await fetch(
		`${must().BASE}/api/task/launch-context?project=${encodeURIComponent(must().MY_PROJ)}&id=${wid}`,
	);
	expect(r.status).toBe(200);
	const j = (await r.json()) as {
		ok: boolean;
		source: string;
		text: string;
	};
	expect(j.ok).toBe(true);
	expect(j.source).toBe("brief");
	expect(j.text).toBe(BRIEF); // exact stored bytes
});

test("api: unknown id 404s honestly", async () => {
	const r = await fetch(
		`${must().BASE}/api/task/launch-context?project=${encodeURIComponent(must().MY_PROJ)}&id=W99999`,
	);
	expect(r.status).toBe(404);
});

test("drawer renders the exact stored brief, full and scrollable", async ({
	page,
}) => {
	await page.goto(
		`${must().BASE}/#task=${wid}&proj=${encodeURIComponent(must().MY_PROJ)}`,
	);
	const ta = page.locator("#taskLaunchText");
	await expect(ta).toHaveCount(1);
	const value = await ta.inputValue();
	expect(value).toBe(BRIEF); // string equality against the stored record
	expect(value.length).toBeGreaterThan(4000); // the long-brief acceptance
	// no truncation: the whole brief is in the box and the box scrolls
	const metrics = await ta.evaluate((el, tail) => {
		const t = el as HTMLTextAreaElement;
		return {
			readOnly: t.readOnly,
			scrolls: t.scrollHeight > t.clientHeight,
			hasTail: t.value.endsWith(`${tail}\n`),
		};
	}, BRIEF_TAIL);
	expect(metrics.readOnly).toBe(true);
	expect(metrics.scrolls).toBe(true);
	expect(metrics.hasTail).toBe(true);
	// scroll actually reaches the end without the text being cut
	await ta.evaluate((el) => (el as HTMLTextAreaElement).scrollTo(0, 1e9));
	const atEnd = await ta.evaluate(
		(el) =>
			(el as HTMLTextAreaElement).scrollTop +
				(el as HTMLTextAreaElement).clientHeight >=
			(el as HTMLTextAreaElement).scrollHeight - 1,
	);
	expect(atEnd).toBe(true);
});

test("manual take without a brief shows the labeled item fields", async ({
	page,
}) => {
	await page.goto(
		`${must().BASE}/#task=${takeId}&proj=${encodeURIComponent(must().MY_PROJ)}`,
	);
	const section = page.locator("#taskLaunch");
	await expect(section).toContainText(
		"launch context — what this lane was told",
	);
	await expect(section).toContainText("from item fields — no stored brief");
	const value = await page.locator("#taskLaunchText").inputValue();
	expect(value).toContain("[description] raw field text");
	expect(value).toContain("[alloc_reason] manual take");
});

test("capsule-less lane shows the honest empty state, never a blank box", async ({
	page,
}) => {
	await page.goto(
		`${must().BASE}/#task=${bareId}&proj=${encodeURIComponent(must().MY_PROJ)}`,
	);
	const section = page.locator("#taskLaunch");
	await expect(section).toContainText(
		"no stored launch context (pre-capsule lane)",
	);
	await expect(page.locator("#taskLaunchText")).toHaveCount(0);
});
