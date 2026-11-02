// e2e/klh-task-card.spec.ts — W2267.4.1: the standalone Lit task card,
// render-and-look on a REAL board page (scratch HOME, /vendor bundles
// served by routes-data). The card markup rides a route-interception mount
// (the board-status-badge pattern — no DOM-building APIs in spec source;
// only .card property assignment happens in-page), because the wiring lane
// W2267.4.2 owns board integration. Proves the component's own contract:
// state fixtures render, unknown metrics stay "—", long text keeps its
// full form accessible, footer actions are keyboard-reachable and carry
// id/project/action on typed events, property updates preserve a focused
// select and the picks, the configurable perimeter (--prefer) is
// independent of the status hue, and nested split children render dashed.
// Screenshots land in /tmp/w2267-4-1-shots.
import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { TaskCardModel } from "../hooks/board-html/klh-task-card-model.ts";

const SHOTS = "/tmp/w2267-4-1-shots";
mkdirSync(SHOTS, { recursive: true });

const HOST_ID = "tc-host";

const EXECUTORS = [
	{ value: "glm-5.3", label: "glm-5.3", badge: "[L] " },
	{ value: "claude", label: "claude", badge: "" },
];

const FIXTURES: TaskCardModel[] = [
	{
		id: "W2267",
		project: "/tmp/fleet/.git",
		title: "Board redesign",
		state: "READY",
		ageS: 900,
		executors: EXECUTORS,
		executorPick: "glm-5.3",
		effortOptions: ["low", "medium", "high"],
		effortPick: "medium",
	},
	{
		id: "W2267.4",
		project: "/tmp/fleet/.git",
		title: "Lit cards for the fleet board",
		state: "CLAIMED",
		ageS: 3660,
		model: "glm-5.3",
		host: "autow2267-4",
		metrics: {
			tokens: 1_234_567,
			wallMs: 654_000,
			tokPerMin: 4321.6,
			cachePct: 94.4,
		},
		executors: EXECUTORS,
		executorPick: "glm-5.3",
	},
	{
		id: "W2267.2",
		project: "/tmp/fleet/.git",
		title: "Activity strip",
		state: "SHATTERED",
		ageS: 86_400,
		parentRef: "W2267",
		nested: true,
		preferColor: "#654b9e",
	},
	{
		id: "W2267.3",
		project: "/tmp/fleet/.git",
		title: "Recovery rail",
		state: "FAILED",
		ageS: 172_800,
		warn: "3 honest attempts — provider 503 loop; tree restored",
		metrics: { tokens: 42_000, wallMs: 3_600_000 },
	},
	{
		id: "W2267.5",
		project: "/tmp/fleet/.git",
		title: "Browser verification",
		state: "DONE",
		ageS: 259_200,
		metrics: { tokens: 1_000_000, wallMs: 7_200_000, tokPerMin: 1000, cachePct: 0 },
	},
];

/** Serve the board page with a fixture host appended before </body>, then
 * assign each card its model. The slotted stand-in rides the same markup. */
async function mount(
	page: Page,
	cards: TaskCardModel[],
	opts: { width?: number; slotActivity?: boolean } = {},
): Promise<void> {
	const width = opts.width ?? 600;
	const inner = cards
		.map((_, i) => `<klh-task-card id="tc${i}"></klh-task-card>`)
		.join("");
	const strip = opts.slotActivity
		? '<div class="strip-standin" slot="activity" style="height:41px"></div>'
		: "";
	const hostHtml = `<div id="${HOST_ID}" style="width:${width}px;padding:12px">${inner}${strip}</div>`;
	await page.route("**/", async (route) => {
		const response = await route.fetch();
		const html = (await response.text()).replace("</body>", `${hostHtml}</body>`);
		await route.fulfill({ response, body: html });
	});
	const url = new URL(page.url());
	await page.goto(url.origin ? url.href : ".");
	await page.evaluate(
		({ models, hostId }) => {
			const host = document.getElementById(hostId);
			if (!host) throw new Error("fixture host missing");
			const els = host.querySelectorAll("klh-task-card");
			models.forEach((model, i) => {
				const el = els[i] as unknown as { card: unknown };
				el.card = model;
			});
		},
		{ models: cards, hostId: HOST_ID },
	);
	await page
		.locator(`#${HOST_ID} klh-task-card`)
		.first()
		.waitFor({ state: "visible" });
}

test("renders every state fixture with the SIGNAL hierarchy", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`); // establish origin for the route glob
	await mount(page, FIXTURES);
	const card = (i = 0) => page.locator(`#${HOST_ID} klh-task-card`).nth(i);
	await expect(page.locator(`#${HOST_ID} klh-task-card`)).toHaveCount(FIXTURES.length);
	await expect(card().locator(".stw")).toHaveText("ready");
	await expect(card().locator(".age")).toHaveText("15m");
	await expect(card().locator(".age")).toHaveCount(1); // no duplicate age
	await expect(card().locator(".tid")).toHaveText("W2267");
	await expect(card(1).locator(".col").first()).toContainText("glm-5.3");
	await expect(card(1).locator(".col").last()).toContainText("autow2267-4");
	await expect(card().locator(".col b").first()).toHaveText("—");
	await expect(card(1).locator(".mv")).toHaveText(["1.2M", "11m", "4.3k", "94%"]);
	await expect(card(1).locator(".ml")).toHaveText(["tokens", "time", "tok/min", "cache"]);
	await expect(card(4).locator(".mv")).toHaveText(["1.0M", "2h00m", "1.0k", "0%"]);
	const failed = card(3);
	await expect(failed.locator(".warn")).toBeVisible();
	const warnBeforeMetrics = await failed.evaluate((n) => {
		const root = n.shadowRoot;
		const warn = root?.querySelector(".warn");
		const metrics = root?.querySelector(".metrics");
		return !!(warn && metrics && warn.compareDocumentPosition(metrics) & Node.DOCUMENT_POSITION_FOLLOWING);
	});
	expect(warnBeforeMetrics).toBe(true);
	await expect(card(2)).toHaveAttribute("data-nested", "");
	await expect(card(2).locator(".elbow")).toBeVisible();
	await expect(card(2)).toContainText("↳ W2267");
	await expect(failed.locator("footer .seg").filter({ hasText: /\S/ })).toHaveText(["Retry", "Recover → Ready", "Prompt ↗"]);
	await page.screenshot({ path: `${SHOTS}/1-fixtures-dark-600.png` });
});

test("long title truncates but full text stays accessible", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	const long = "OWNER-GATED: Rebuild the entire fleet board masthead, navigation, orchestration strip and lane columns in the approved MIT-Press editorial language with restrained rules and monospaced identifiers";
	await mount(page, [{ ...FIXTURES[1]!, id: "WLONG", title: long }]);
	const card = page.locator(`#${HOST_ID} klh-task-card`);
	await expect(card.locator(".tid")).toHaveText("WLONG");
	const box = await card.locator(".title").boundingBox();
	expect(box?.height ?? 0).toBeLessThan(70); // clamped to ~3 lines
	await expect(card.locator(".title")).toHaveAttribute("title", long);
});

test("footer actions are keyboard reachable and fire typed events", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, [FIXTURES[0]!, FIXTURES[3]!]);
	const card = (i = 0) => page.locator(`#${HOST_ID} klh-task-card`).nth(i);
	const events: { action: string; id: string; project: string | null }[] = [];
	await page.exposeFunction("tcEvent", (e: { action: string; id: string; project: string | null }) => events.push(e));
	await page.evaluate((hostId) => {
		document.getElementById(hostId)?.addEventListener("task-card-action-requested", (e) => {
			const ev = e as unknown as { action: string; id: string; project: string | null };
			window.tcEvent({ action: ev.action, id: ev.id, project: ev.project });
		});
	}, HOST_ID);
	await card(1).locator(".seg.retry").focus();
	await page.keyboard.press("Enter");
	await expect.poll(() => events).toEqual([{ action: "retry", id: "W2267.3", project: "/tmp/fleet/.git" }]);
	await card(1).locator(".seg.recover").click();
	await card(1).locator(".seg.prompt").click();
	await expect.poll(() => events.map((e) => e.action)).toEqual(["retry", "recover", "prompt"]);
	await card().locator("select[aria-label^=executor]").selectOption("claude");
	await card().locator(".seg.start").click();
	await expect.poll(() => events.length).toBe(4);
	expect(events[3]).toMatchObject({ action: "start", id: "W2267" });
	const opened = await page.evaluate((hostId) => {
		let seen = false;
		const host = document.getElementById(hostId);
		host?.addEventListener("task-card-open-requested", () => { seen = true; });
		const el = host?.querySelector("klh-task-card");
		el?.shadowRoot?.querySelector(".tid")?.click();
		return seen;
	}, HOST_ID);
	expect(opened).toBe(true);
	expect(events.length).toBe(4); // open is its own event, no action side-fires
});

test("property update preserves focused select and the picks", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, [FIXTURES[0]!]);
	const card = page.locator(`#${HOST_ID} klh-task-card`);
	const exec = card.locator("select[aria-label^=executor]");
	await exec.focus();
	await exec.selectOption("claude");
	await page.evaluate((hostId) => {
		const el = document.getElementById(hostId)?.querySelector("klh-task-card") as unknown as { card: TaskCardModel };
		el.card = { ...el.card, ageS: 960, title: "Board redesign (updated)" };
	}, HOST_ID);
	await expect(card.locator(".age")).toHaveText("16m");
	await expect(card.locator(".title")).toContainText("(updated)");
	await expect(exec).toBeFocused(); // focus survives the property update
	await expect(exec).toHaveValue("claude"); // operator pick stays
	await expect(card.locator("select[aria-label^=reasoning]")).toHaveValue("medium");
});

test("perimeter color independent of status hue, both themes", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, [{ ...FIXTURES[1]!, preferColor: "#654b9e" }, FIXTURES[0]!]);
	const card = (i = 0) => page.locator(`#${HOST_ID} klh-task-card`).nth(i);
	const hues = await card().evaluate((n) => {
		const cs = getComputedStyle(n);
		return { perimeter: cs.borderColor, state: cs.getPropertyValue("--state-color").trim(), prefer: cs.getPropertyValue("--prefer").trim() };
	});
	expect(hues.prefer).toBe("#654b9e");
	expect(hues.state).not.toBe(hues.prefer); // working blue ≠ purple perimeter
	await page.evaluate(() => localStorage.setItem("klh-theme", "light"));
	await page.reload();
	await card().waitFor({ state: "visible" });
	const light = await card().evaluate((n) => {
		const cs = getComputedStyle(n);
		return { perimeter: cs.borderColor, prefer: cs.getPropertyValue("--prefer").trim(), tone: (n as HTMLElement).dataset.tone };
	});
	expect(light.prefer).toBe("#654b9e");
	expect(light.tone).toBe("working");
	await page.screenshot({ path: `${SHOTS}/2-prefer-light-600.png` });
});

test("renders at narrow width without clipping the footer", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, [FIXTURES[3]!], { width: 300 });
	const card = page.locator(`#${HOST_ID} klh-task-card`);
	await expect(card.locator("footer .seg.retry")).toBeVisible();
	const cardBox = await card.boundingBox();
	const footBox = await card.locator("footer").boundingBox();
	expect(footBox?.width ?? 0).toBeLessThanOrEqual((cardBox?.width ?? 0) + 1);
	const h = await card.locator("footer .seg.retry").evaluate((n) => n.getBoundingClientRect().height);
	expect(h).toBeGreaterThanOrEqual(32);
	await page.screenshot({ path: `${SHOTS}/3-failed-300.png` });
});

test("activity slot hosts the strip flush at the card bottom", { tag: "@ui" }, async ({ page, board }) => {
	await page.goto(`${board.BASE}/`);
	await mount(page, [{ ...FIXTURES[1]!, activity: { mode: "spend", windowStartMs: Date.now() - 1_800_000, windowEndMs: Date.now(), binMs: 180_000, elapsedMs: 654_000, scaleMs: 86_400_000 } }], { slotActivity: true });
	const card = page.locator(`#${HOST_ID} klh-task-card`);
	const strip = card.locator(".strip-standin");
	await expect(strip).toBeVisible();
	const stripBox = await strip.boundingBox();
	const footBox = await card.locator("footer").boundingBox();
	expect(stripBox && footBox && footBox.y - (stripBox.y + stripBox.height)).toBeLessThan(1);
	await page.screenshot({ path: `${SHOTS}/4-activity-slot.png` });
});
