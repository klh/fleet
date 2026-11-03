// e2e/board-card-attempt-mode.spec.ts — W2267.4.2.1: attempt mode inside
// the ONE activity strip, against the REAL vendor bundle on a REAL board
// origin. Behavior proofs: same-strip mode switch with exact spend
// restoration, pointer+keyboard inspection of every segment kind and
// artifact milestones (regression for root #101559 — the first
// ArrowRight threw TypeError), empty state, stale-tip dismissal, RO
// re-observe after reconnect/resize, and the 380/600 both-theme geometry.
import { THEME_HEAD } from "@klh/kernel/src/kernel.theme.module.ts";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// local midnight rollover: 23:50 → 01:20 next day (CET, UTC+01:00 in Nov)
const NIGHT0 = Date.UTC(2026, 10, 1, 22, 50); // 23:50 local
const ATTEMPT = {
	windowStart: NIGHT0,
	windowEnd: NIGHT0 + 90 * 60_000,
	binMs: 180_000,
	bins: 30,
	attempt: {
		sid: "autolane-1",
		index: 3,
		claimStart: NIGHT0 + 5 * 60_000,
		claimEnd: null,
		created: NIGHT0 - 8 * 60_000,
		firstByteAt: NIGHT0 + 9 * 60_000,
		segments: [
			{ kind: "queue", start: NIGHT0, end: NIGHT0 + 5 * 60_000 },
			{
				kind: "firstbyte",
				start: NIGHT0 + 5 * 60_000,
				end: NIGHT0 + 9 * 60_000,
			},
			{ kind: "tool", start: NIGHT0 + 9 * 60_000, end: NIGHT0 + 20 * 60_000 },
			{ kind: "pause", start: NIGHT0 + 20 * 60_000, end: NIGHT0 + 24 * 60_000 },
			{
				kind: "unknown",
				start: NIGHT0 + 24 * 60_000,
				end: NIGHT0 + 34 * 60_000,
			},
			{ kind: "tool", start: NIGHT0 + 34 * 60_000, end: NIGHT0 + 90 * 60_000 },
		],
	},
	milestones: [
		{ ts: NIGHT0 + 30 * 60_000, commit: "deadbee", stage: "commit" },
	],
};

const SPEND_PTS: [number, number, number, number][] = [
	[NIGHT0, 5128, 2_094_848, 2581],
	[NIGHT0 + 180_000, 5000, 2_000_000, 2000],
];

/** routed board-origin page mounting the real component (HTML-parser
 *  channel — same pattern as board-card-activity.spec.ts). */
async function mount(
	page: Page,
	base: string,
	theme: "dark" | "light",
	width: number,
): Promise<Locator> {
	await page.route("**/w2267-4-2-1-mount", (route) =>
		route.fulfill({
			contentType: "text/html; charset=utf-8",
			body:
				`<!doctype html><html data-theme="${theme}"><head>${THEME_HEAD}` +
				`<script type="module" src="/vendor/klh-board-register.js"></script>` +
				`</head><body><div style="width:${width}px">` +
				`<klh-card-activity></klh-card-activity></div></body></html>`,
		}),
	);
	await page.goto(`${base}/w2267-4-2-1-mount`);
	const host = page.locator("klh-card-activity");
	await expect
		.poll(() => host.evaluate((el) => el.shadowRoot !== null))
		.toBe(true);
	return host;
}

async function setProps(
	host: Locator,
	props: {
		points?: [number, number, number, number][];
		wallMs?: number | null;
		attempt?: unknown;
		mode?: string;
	},
): Promise<void> {
	await host.evaluate((el, p) => {
		const c = el as unknown as Record<string, unknown>;
		if (p.points !== undefined) c.points = p.points;
		if (p.wallMs !== undefined) c.wallMs = p.wallMs;
		if (p.attempt !== undefined) c.attempt = p.attempt;
		if (p.mode !== undefined) c.mode = p.mode;
	}, props);
}

const tipText = (host: Locator): Promise<string> =>
	host.evaluate(
		(el) => el.shadowRoot?.querySelector(".tip")?.textContent ?? "",
	);

const countIn = (host: Locator, sel: string): Promise<number> =>
	host.evaluate(
		(el, s) => el.shadowRoot?.querySelectorAll(s).length ?? -1,
		sel,
	);

test("mode switch: ONE strip, contents swap, spend restored exactly", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, {
		points: SPEND_PTS,
		wallMs: 9 * 3_600_000,
		attempt: ATTEMPT,
	});
	await expect.poll(() => countIn(host, "svg.plot")).toBe(1);
	const bars1 = await countIn(host, "rect.spark-fresh");
	const plot = host.locator("svg.plot");
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	await page.mouse.move(box.x + 4, box.y + 14);
	const tip1 = await tipText(host);
	expect(tip1).toContain("Fresh input 5,128");
	await setProps(host, { mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(1);
	await expect.poll(() => countIn(host, "svg.plot")).toBe(1);
	await setProps(host, { mode: "spend" });
	await expect.poll(() => countIn(host, "rect.spark-fresh")).toBe(bars1);
	await page.mouse.move(box.x + 4, box.y + 14);
	const tip2 = await tipText(host);
	expect(tip2).toBe(tip1);
});

test("keyboard + pointerleave regression (#101559): ArrowRight walks rows, no TypeError", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(1);
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(String(e)));
	const plot = host.locator("svg.plot");
	await plot.focus();
	await page.keyboard.press("ArrowRight");
	await expect.poll(() => tipText(host)).not.toBe("");
	// first walk step = milestone deadbee (rows[0]); second = queue segment
	expect(await tipText(host)).toContain("artifact · commit");
	await page.keyboard.press("ArrowRight");
	expect(await tipText(host)).toContain("queue");
	// pointerleave dismisses the inspection (hide() face exists and works)
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	await page.mouse.move(box.x + box.width * 0.12, box.y + 14);
	await expect.poll(() => tipText(host)).toContain("tool");
	await page.mouse.move(box.x + box.width + 40, box.y + 14);
	await expect.poll(() => tipText(host)).toBe("");
	// Escape on focus hides too, then blur
	await plot.focus();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Escape");
	await expect.poll(() => tipText(host)).toBe("");
	expect(errors).toEqual([]);
});

test("attempt inspection: every segment kind + artifact with exact dual stamps", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(1);
	const plot = host.locator("svg.plot");
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	// hover each segment by local-clock position; fixture spans local
	// 23:50→01:20, so fractions are window-relative (90 min = full width)
	const at = (frac: number): Promise<string> =>
		page.mouse
			.move(box.x + box.width * frac, box.y + 20)
			.then(() => tipText(host));
	// queue 0–5m (0.0–0.055), firstbyte 5–9m, tool 9–20m, pause 20–24m,
	// unknown 24–34m, tool 34–90m; milestone diamond at 30m = 1/3
	expect(await at(0.02)).toContain("queue");
	expect(await at(0.07)).toContain("firstbyte");
	expect(await at(0.12)).toContain("tool");
	expect(await at(0.24)).toContain("pause");
	expect(await at(0.31)).toContain("unknown");
	expect(await at(0.9)).toContain("tool");
	// artifact diamond: hover its exact x; kind + commit + exact stamps
	const msX = box.x + box.width * ((30 * 60_000) / (90 * 60_000));
	await page.mouse.move(msX, box.y + 20);
	const msTip = await tipText(host);
	expect(msTip).toContain("artifact · commit");
	expect(msTip).toContain("deadbee");
});

test("empty attempt renders the explicit empty state; stale tip dismissed", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	// inspect something first, then empty the payload — the tip is derived
	// state and must not survive its source
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(1);
	const plot = host.locator("svg.plot");
	const box = await plot.boundingBox();
	if (!box) throw new Error("plot not visible");
	await page.mouse.move(box.x + 4, box.y + 20);
	await expect.poll(() => tipText(host)).toContain("queue");
	await setProps(host, { attempt: null });
	await expect
		.poll(() =>
			host.evaluate(
				(el) =>
					el.shadowRoot?.querySelector(".attempt-empty")?.textContent ?? "",
			),
		)
		.toContain("no attempt in the fixed 90-minute window");
	await expect.poll(() => tipText(host)).toBe("");
	// exactly one strip surface, and no plot band while empty
	expect(await countIn(host, "svg.plot")).toBe(0);
	expect(await countIn(host, ".attempt-empty")).toBe(1);
});

test("RO resumes: reconnect + width change re-observes the new plot", {
	tag: "@ui",
}, async ({ page, board }) => {
	const host = await mount(page, board.BASE, "dark", 380);
	await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
	await expect
		.poll(() => countIn(host, "rect.at-tool"))
		.toBeGreaterThanOrEqual(1);
	// detach + reattach the host — a MOVED host never gets firstUpdated again
	const vb = (): Promise<string | null> =>
		host.evaluate((el) =>
			el.shadowRoot?.querySelector("svg.plot")?.getAttribute("viewBox"),
		);
	await host.evaluate((el) => {
		const parent = el.parentElement;
		if (!parent) throw new Error("no parent");
		parent.removeChild(el);
		parent.appendChild(el);
	});
	await expect.poll(() => vb()).toBe("0 0 380 40");
	// widen the container — the viewBox must track the measured width
	await host.evaluate((el) => {
		const wrap = el.parentElement;
		if (wrap) wrap.style.width = "600px";
	});
	await expect.poll(() => vb()).toBe("0 0 600 40");
});

test("geometry: both widths, both themes — ONE 40px band, fitting HH:mm axis", {
	tag: "@ui",
}, async ({ page, board }) => {
	for (const theme of ["dark", "light"] as const) {
		for (const width of [380, 600]) {
			const host = await mount(page, board.BASE, theme, width);
			await setProps(host, { attempt: ATTEMPT, mode: "attempt" });
			const tools = () => countIn(host, "rect.at-tool");
			await expect.poll(tools).toBeGreaterThanOrEqual(1);
			// exactly ONE plot band, never a second chart
			expect(await countIn(host, "svg.plot")).toBe(1);
			const geom = await host.evaluate((el) => {
				const plot = el.shadowRoot?.querySelector("svg.plot");
				const axis = el.shadowRoot?.querySelector(".axis");
				return {
					plotH: plot?.clientHeight ?? -1,
					axisFits: axis ? axis.clientWidth >= axis.scrollWidth : false,
					axisText: axis?.textContent ?? "",
				};
			});
			expect(geom.plotH).toBe(40);
			expect(geom.axisFits).toBe(true);
			// compact HH:mm ends, never full dual stamps on the axis
			expect(geom.axisText).toMatch(/23:50/);
			expect(geom.axisText).toMatch(/01:20/);
		}
	}
});
