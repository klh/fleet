// e2e/board-feed-share.spec.ts — one poller per browser (FeedStore share()):
// against a REAL board, four tabs in one browser context cost the polled
// /api/ request rate of one tab, only the Web Lock leader fetches, and
// closing the leader hands polling to a follower within one poll interval.

import { expect, test } from "@playwright/test";
import { startBoard } from "../test/helpers/board-harness";

let b: Awaited<ReturnType<typeof startBoard>>;
const WINDOW_MS = 6000;

test.beforeAll(async () => {
	b = await startBoard("feedshare");
});

test.afterAll(async () => {
	await b.stop();
});

/** Open n tabs, let boot settle, then count /api/ requests per tab. */
async function measure(browser, n) {
	const ctx = await browser.newContext();
	const pages = [];
	for (let i = 0; i < n; i++) {
		const p = await ctx.newPage();
		await p.goto(`${b.BASE}/`);
		pages.push(p);
	}
	await pages[0].waitForTimeout(2500); // boot fetches + election settle
	const counts = new Map(pages.map((p) => [p, 0]));
	ctx.on("request", (r) => {
		if (!new URL(r.url()).pathname.startsWith("/api/")) return;
		const p = r.frame()?.page();
		if (p && counts.has(p)) counts.set(p, (counts.get(p) ?? 0) + 1);
	});
	await pages[0].waitForTimeout(WINDOW_MS);
	return { ctx, pages, counts };
}

const roleOf = (p) => p.evaluate(() => globalThis.klhFeeds?.role);

test("4 tabs poll at the rate of 1; followers make no requests", {
	tag: "@ui",
}, async ({ browser }) => {
	const one = await measure(browser, 1);
	const solo = [...one.counts.values()][0];
	await one.ctx.close();
	expect(solo).toBeGreaterThan(0);

	const four = await measure(browser, 4);
	const roles = await Promise.all(four.pages.map(roleOf));
	expect(roles.filter((r) => r === "leader")).toHaveLength(1);
	expect(roles.filter((r) => r === "follower")).toHaveLength(3);
	let total = 0;
	for (const [p, c] of four.counts) {
		total += c;
		if ((await roleOf(p)) === "follower") expect(c).toBe(0);
	}
	test.info().annotations.push({
		type: "api-requests-per-window",
		description: `1 tab ${solo} · 4 tabs ${total} (${WINDOW_MS}ms)`,
	});
	// same scope everywhere ⇒ the leader serves all four from one poll set
	expect(total).toBeLessThanOrEqual(Math.ceil(solo * 1.5) + 2);
	await four.ctx.close();
});

test("closing the leader hands polling to a follower", {
	tag: "@ui",
}, async ({ browser }) => {
	const ctx = await browser.newContext();
	const pages = [];
	for (let i = 0; i < 3; i++) {
		const p = await ctx.newPage();
		await p.goto(`${b.BASE}/`);
		pages.push(p);
	}
	await expect
		.poll(async () => (await Promise.all(pages.map(roleOf))).sort())
		.toEqual(["follower", "follower", "leader"]);
	const roles = await Promise.all(pages.map(roleOf));
	const leader = pages[roles.indexOf("leader")];
	const rest = pages.filter((p) => p !== leader);
	const seen = new Set();
	ctx.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/data")
			seen.add(r.frame()?.page());
	});
	await leader.close();
	await expect
		.poll(async () => (await Promise.all(rest.map(roleOf))).sort())
		.toEqual(["follower", "leader"]);
	const next = rest[(await Promise.all(rest.map(roleOf))).indexOf("leader")];
	// the new leader polls /api/data within one interval (+ RTT slack)
	await expect.poll(() => seen.has(next), { timeout: 5000 }).toBe(true);
	// …and the remaining follower still gets fresh data without fetching
	const other = rest.find((p) => p !== next);
	const okAt = () =>
		other.evaluate(() => globalThis.klhFeeds?.get("data")?.okAt ?? 0);
	const before = await okAt();
	await expect.poll(okAt, { timeout: 5000 }).toBeGreaterThan(before);
	expect(seen.has(other)).toBe(false);
	await ctx.close();
});
