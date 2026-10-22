import { expect, test } from "bun:test";
import { verifyRestartDrain } from "../scripts/lib/claude-restart-operation.ts";

test("restart drain uses exact server-side lane filter and refuses incomplete or foreign coverage", async () => {
	const sid = "exact-restart-lane";
	let rows: Array<{ lane: string; status: number | null }> = [];
	const queries: URLSearchParams[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			queries.push(new URL(request.url).searchParams);
			return Response.json({ requests: rows });
		},
	});
	const probe = () =>
		verifyRestartDrain(`http://127.0.0.1:${server.port}`, sid, {});
	try {
		await probe();
		expect(queries[0].get("lane")).toBe(sid);
		expect(queries[0].get("inference")).toBe("true");
		rows = [{ lane: sid, status: null }];
		await expect(probe()).rejects.toThrow("not drained");
		rows = [{ lane: "unrelated-lane", status: 200 }];
		await expect(probe()).rejects.toThrow("coverage is unknown");
		rows = Array.from({ length: 500 }, () => ({ lane: sid, status: 200 }));
		await expect(probe()).rejects.toThrow("coverage is unknown");
		rows = [{ lane: sid, status: 200 }];
		await probe();
	} finally {
		server.stop(true);
	}
});
