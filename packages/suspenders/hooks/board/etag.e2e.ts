// hooks/board/etag.e2e.ts — the polled-feed ETag contract: stable across
// the `ts` stamp, 304 on If-None-Match, a real change mints a new tag.
import { expect, test } from "@playwright/test";
import { jsonEtag } from "./etag.ts";

const req = (tag?: string) =>
	new Request("http://board.local/api/data", {
		headers: tag ? { "if-none-match": tag } : {},
	});

test.describe("@unit", () => {
	test("body carries a weak etag and no-cache", async () => {
		const r = jsonEtag(req(), { ts: 1, a: 1 });
		expect(r.status).toBe(200);
		expect(r.headers.get("etag")).toMatch(/^W\/"[\w-]{22}"$/);
		expect(r.headers.get("cache-control")).toBe("no-cache");
		expect(r.headers.get("content-type")).toBe("application/json");
		expect(await r.json()).toEqual({ ts: 1, a: 1 });
	});

	test("the ts stamp alone does not change the tag; If-None-Match → 304", async () => {
		const tag = jsonEtag(req(), { ts: 1, a: 1 }).headers.get("etag") ?? "";
		const again = jsonEtag(req(tag), { ts: 2, a: 1 });
		expect(again.status).toBe(304);
		expect(again.headers.get("etag")).toBe(tag);
		expect(await again.text()).toBe("");
	});

	test("a real change mints a new tag and sends the body", async () => {
		const tag = jsonEtag(req(), { ts: 1, a: 1 }).headers.get("etag") ?? "";
		const moved = jsonEtag(req(tag), { ts: 1, a: 2 });
		expect(moved.status).toBe(200);
		expect(moved.headers.get("etag")).not.toBe(tag);
		expect(await moved.json()).toEqual({ ts: 1, a: 2 });
	});

	test("unstamped payloads hash the whole body", () => {
		const a = jsonEtag(req(), { ok: true, tasks: [] }).headers.get("etag");
		const b = jsonEtag(req(), { ok: true, tasks: [1] }).headers.get("etag");
		expect(a).not.toBe(b);
	});

	test("relative ages and build stamps never move the tag; absolute stamps do", () => {
		const feed = (now, hb) => ({
			ts: now,
			decisionsTs: now,
			observation: { observedAt: now, expiresAt: now + 5000 },
			laneObservations: { ts: now, lanes: [{ sid: "s1" }] },
			sessions: [{ sid: "s1", hb, hbAgo: Math.round((now - hb) / 1000) }],
			tasks: [{ id: "W1", age_s: now - hb }],
		});
		const tag = jsonEtag(req(), feed(10_000, 1000)).headers.get("etag") ?? "";
		const later = jsonEtag(req(tag), feed(99_000, 1000));
		expect(later.status).toBe(304);
		const beat = jsonEtag(req(tag), feed(99_000, 2000));
		expect(beat.status).toBe(200);
		expect(beat.headers.get("etag")).not.toBe(tag);
	});

	test("a nested `ts` outside laneObservations still counts", () => {
		const a = jsonEtag(req(), { events: [{ id: 1, ts: 1 }] });
		const b = jsonEtag(req(), { events: [{ id: 1, ts: 2 }] });
		expect(a.headers.get("etag")).not.toBe(b.headers.get("etag"));
	});
});
