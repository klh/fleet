import { expect, test } from "bun:test";
import { BoardClient, BoardError } from "../src/api";

const ok = (body: unknown): typeof fetch =>
	(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		)) as unknown as typeof fetch;

const fail = (status: number): typeof fetch =>
	(() =>
		Promise.resolve(
			new Response("nope", { status }),
		)) as unknown as typeof fetch;

test("tasks() returns the feed", async () => {
	const c = new BoardClient(
		"http://board.test",
		ok({ ok: true, projects: ["/p/a/.git"], tasks: [] }),
	);
	const f = await c.tasks();
	expect(f.projects).toEqual(["/p/a/.git"]);
	expect(f.tasks).toEqual([]);
});

test("task() encodes project + id", async () => {
	let seen = "";
	const probe = ((path: string | URL | Request) => {
		seen = String(path);
		return Promise.resolve(
			new Response(
				JSON.stringify({ ok: true, task: {}, events: [], decisions: [] }),
				{ status: 200 },
			),
		);
	}) as unknown as typeof fetch;
	const c = new BoardClient("http://board.test", probe);
	await c.task("/p/a b/.git", "W7");
	expect(seen).toBe(
		"http://board.test/api/task?project=%2Fp%2Fa%20b%2F.git&id=W7",
	);
});

test("non-2xx → BoardError with status", async () => {
	const c = new BoardClient("http://board.test", fail(500));
	try {
		await c.tasks();
		expect.unreachable();
	} catch (err) {
		expect(err).toBeInstanceOf(BoardError);
		expect((err as BoardError).status).toBe(500);
	}
});

test("ok:false body → BoardError carrying the error text", async () => {
	const c = new BoardClient(
		"http://board.test",
		ok({ ok: false, error: "no work item W99 in /p/x/.git" }),
	);
	try {
		await c.task("/p/x/.git", "W99");
		expect.unreachable();
	} catch (err) {
		expect((err as BoardError).message).toContain("no work item W99");
	}
});

test("rejected fetch → BoardError status 0", async () => {
	const c = new BoardClient("http://board.test", (() =>
		Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch);
	try {
		await c.tasks();
		expect.unreachable();
	} catch (err) {
		expect((err as BoardError).status).toBe(0);
	}
});
