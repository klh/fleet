// poll-memo — the board's polled feeds serve one serialization per window,
// with an etag, and answer a matching If-None-Match with an empty 304.
import { expect, test } from "@playwright/test";
import { respondCached as jsonBody } from "./etag.ts";
import { clearPollMemo, pollMemoBody } from "./poll-memo.ts";

test("pollMemoBody stringifies once per window and re-serializes after it @unit", () => {
	clearPollMemo();
	let computes = 0;
	const compute = () => ({ n: ++computes });
	const t0 = Date.now();
	const a = pollMemoBody("k", compute, t0);
	const b = pollMemoBody("k", compute, t0 + 10);
	expect(b).toBe(a);
	expect(computes).toBe(1);
	expect(JSON.parse(a.body)).toEqual({ n: 1 });
	const c = pollMemoBody("k", compute, t0 + 60_000);
	expect(computes).toBe(2);
	expect(c.etag).not.toBe(a.etag);
	clearPollMemo();
});

test("jsonBody serves cached bytes and 304s a matching If-None-Match @unit", async () => {
	clearPollMemo();
	const cached = pollMemoBody("j", () => ({ ok: true, rows: [1, 2] }));
	const fresh = jsonBody(new Request("http://x/api/tasks"), cached);
	expect(fresh.status).toBe(200);
	expect(fresh.headers.get("etag")).toBe(cached.etag);
	expect(await fresh.text()).toBe(cached.body);
	const same = jsonBody(
		new Request("http://x/api/tasks", {
			headers: { "if-none-match": cached.etag },
		}),
		cached,
	);
	expect(same.status).toBe(304);
	expect(await same.text()).toBe("");
	// a compressing front may weaken/suffix the tag — still the same body
	const weak = jsonBody(
		new Request("http://x/api/tasks", {
			headers: { "if-none-match": `${cached.etag.slice(0, -1)}-gzip"` },
		}),
		cached,
	);
	expect(weak.status).toBe(304);
	const stale = jsonBody(
		new Request("http://x/api/tasks", { headers: { "if-none-match": '"x"' } }),
		cached,
	);
	expect(stale.status).toBe(200);
	clearPollMemo();
});
