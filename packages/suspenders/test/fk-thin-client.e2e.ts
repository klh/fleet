// test/fk-thin-client.e2e.ts — W2779.3.1: the session-hook thin clients
// (lesson push + settle) ride the fk sink faces through knowledge-sink-client
// and fall back to the fleet-local store on any sink miss (seam doc
// compatibility law — the retarget completes as a conf flip).
import { test, expect } from "@playwright/test";
import { serveStub } from "@klh/test-kit";
import {
	type fkWriteConf,
	lessonsViaSink,
	settleViaSink,
	sinkPostFace,
} from "../hooks/lib/knowledge/knowledge-sink-client.ts";
import {
	lessonPushLines,
	lessonsForPush,
} from "../hooks/lib/knowledge/lesson-push.ts";

function stub404() {
	return serveStub(() => new Response("no", { status: 404 }));
}

const wc = (
	url: string,
	writeToken: string | null,
): ReturnType<typeof fkWriteConf> => ({
	conf: { url, key: null, keyFile: null, timeoutMs: 300 },
	writeToken,
});

const rc = (url: string, key: string | null) => ({
	url,
	key,
	keyFile: null,
	timeoutMs: 300,
});

test("lessonsViaSink rides /knowledge/sql with the bksk key and pinned SQL", async () => {
	const stub = serveStub((_req, body) => {
		expect(body?.sql).toContain("knowledge_facts");
		return Response.json({
			rows: [
				{
					key: "lesson.liveness-test-fixtures",
					value: "stubbed lesson",
					ts: 100,
				},
			],
		});
	});
	try {
		const out = await lessonsViaSink(
			{ since: 5, limit: 3 },
			rc(stub.url, "bksk_test"),
		);
		expect(out.ok).toBe(true);
		expect(out.rows).toHaveLength(1);
		expect(out.rows[0]).toMatchObject({
			key: "lesson.liveness-test-fixtures",
			value: "stubbed lesson",
			ts: 100,
		});
		expect(stub.requests[0].auth).toBe("Bearer bksk_test");
		expect(stub.requests[0].body?.params).toEqual([
			"lesson.",
			expect.any(String),
			5,
		]);
	} finally {
		stub.close();
	}
});

test("lessonsViaSink fails open (ok:false, empty rows, no throw) on errors", async () => {
	const down = await lessonsViaSink({}, rc("http://127.0.0.1:9", "k"));
	expect(down.ok).toBe(false);
	expect(down.rows).toEqual([]);
	const noKey = await lessonsViaSink({}, rc(stub404().url, null));
	expect(noKey.ok).toBe(false);
});

test("settleViaSink posts {sid, hub} with the write token and parses counts", async () => {
	const stub = serveStub((_req, body) => {
		expect(body).toMatchObject({ sid: "sid-1", hub: 1 });
		return Response.json({ queueMarked: 3, rowsBackfilled: 7 });
	});
	try {
		const out = await settleViaSink("sid-1", 1, wc(stub.url, "wt_test"));
		expect(out).toMatchObject({ ok: true, queueMarked: 3, rowsBackfilled: 7 });
		expect(stub.requests[0].auth).toBe("Bearer wt_test");
	} finally {
		stub.close();
	}
});

test("settleViaSink refuses without token and fails open on HTTP error", async () => {
	const out = await settleViaSink("s", 0, wc("http://127.0.0.1:9", null));
	expect(out.ok).toBe(false);
	const out2 = await settleViaSink("s", 0, wc(stub404().url, "t"));
	expect(out2.ok).toBe(false);
});

test("lessonsForPush falls back to the local store when the sink misses", async () => {
	const out = await lessonsForPush({ since: 0 }, {
		SUSPENDERS_KNOWLEDGE_SINK_URL: "http://127.0.0.1:9",
	} as NodeJS.ProcessEnv);
	expect(out.via).toBe("local");
	const noSink = await lessonsForPush({ since: 0 }, {} as NodeJS.ProcessEnv);
	expect(noSink.via).toBe("local");
});

test("lessonPushLines truncates long values with the fact-get pointer", () => {
	const lines = lessonPushLines([
		{ key: "lesson.short", value: "tiny", ts: 1 },
		{
			key: "lesson.long",
			value: "x".repeat(201),
			ts: 2,
		},
	]);
	expect(lines[0]).toBe("LESSON short: tiny");
	expect(lines[1]).toContain("… (coord fact get lesson.long)");
});

test("sinkPostFace posts the write-token bearer and fails open on 4xx", async () => {
	const stub = serveStub((_req, body) => {
		expect(body).toMatchObject({ id: 5, by: "klh" });
		return Response.json({ ok: true });
	});
	try {
		const out = await sinkPostFace(
			"/promote",
			{ id: 5, by: "klh" },
			wc(stub.url, "wt"),
		);
		expect(out.ok).toBe(true);
		expect(stub.requests[0].path).toBe("/promote");
		expect(stub.requests[0].auth).toBe("Bearer wt");
		const bad = await sinkPostFace(
			"/promote",
			{ id: 5 },
			wc(stub404().url, "wt"),
		);
		expect(bad.ok).toBe(false);
		expect(bad.status).toBe(404);
	} finally {
		stub.close();
	}
});
