import { expect, test } from "bun:test";
import { verifyRestartDrain } from "../scripts/lib/claude-restart-drain.ts";

interface Row {
	rid: string;
	lane: string;
	ts: string;
	trace_id: string | null;
	status: number | null;
	reconciled: object | null;
}

const SID = "exact-restart-lane";
const T1 = "2026-10-23T00:00:00.000Z";
const T0 = "2026-10-22T00:00:00.000Z";

function row(
	n: number,
	ts: string,
	status: number | null,
	extra: Partial<Row> = {},
): Row {
	return {
		rid: `r${String(n).padStart(4, "0")}`,
		lane: SID,
		ts,
		trace_id: String(n).padStart(32, "0"),
		status,
		reconciled: null,
		...extra,
	};
}

/** Keyset-faithful mock of the W824 admin read: rows ordered ts DESC,
 *  `until` exclusive (ts < until), 500/page. */
function startDrainMock(
	dataset: Row[],
	opts: { reconcileMode?: string; readFail?: boolean } = {},
) {
	const queries: URLSearchParams[] = [];
	const posts: Array<Record<string, unknown>> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST") {
				return (async () => {
					const body = (await request.json()) as Record<string, unknown>;
					posts.push(body);
					if (opts.reconcileMode === "netfail")
						return new Response(null, { status: 503 });
					if (opts.reconcileMode === "ok")
						return Response.json({ reconciled: body.rid, verdict: {} });
					if (opts.reconcileMode === "already")
						return Response.json(
							{ code: "buckle.receipt_reconciled" },
							{ status: 409 },
						);
					if (opts.reconcileMode === "refuse")
						return Response.json(
							{ code: "buckle.receipt_transport_bound" },
							{ status: 409 },
						);
					return new Response("boom", { status: 500 });
				})();
			}
			queries.push(url.searchParams);
			if (opts.readFail) return new Response("down", { status: 503 });
			const until = url.searchParams.get("until");
			const filtered =
				until === null ? dataset : dataset.filter((r) => r.ts < until);
			return Response.json({ requests: filtered.slice(0, 500) });
		},
	});
	return { server, queries, posts };
}

function probe(m: ReturnType<typeof startDrainMock>) {
	return verifyRestartDrain(`http://127.0.0.1:${m.server.port}`, SID, {});
}

/** count rows with DISTINCT per-ms timestamps ending at endMs (ts DESC). */
function spread(count: number, endMs: number, idBase: number): Row[] {
	return Array.from({ length: count }, (_, i) =>
		row(idBase + i, new Date(endMs - i).toISOString(), 200),
	);
}

test("settled single page passes with exact lane filter and no POSTs", async () => {
	const m = startDrainMock([row(1, T1, 200), row(2, T0, 200)]);
	try {
		await probe(m);
		expect(m.queries[0]?.get("lane")).toBe(SID);
		expect(m.queries[0]?.get("inference")).toBe("true");
		expect(m.queries[0]?.get("limit")).toBe("500");
		expect(m.queries[0]?.get("until")).toBe(null);
		expect(m.posts.length).toBe(0);
	} finally {
		m.server.stop(true);
	}
});

test("unsettled row reconciles through the gate and passes", async () => {
	const m = startDrainMock([row(1, T1, null), row(2, T0, 200)], {
		reconcileMode: "ok",
	});
	try {
		await probe(m);
		expect(m.posts.length).toBe(1);
		expect(m.posts[0]?.rid).toBe("r0001");
		expect(m.posts[0]?.lane).toBe(SID);
		expect(m.posts[0]?.reason).toBe("restart-scoped-drain");
		expect(m.posts[0]?.ts).toBe(T1);
	} finally {
		m.server.stop(true);
	}
});

test("row carrying an existing reconciled verdict passes with zero POSTs", async () => {
	const m = startDrainMock([
		row(1, T1, null, { reconciled: { verdict: "abandoned" } }),
		row(2, T0, 200),
	]);
	try {
		await probe(m);
		expect(m.posts.length).toBe(0);
	} finally {
		m.server.stop(true);
	}
});

test("gate 409 receipt_reconciled settles the row", async () => {
	const m = startDrainMock([row(1, T1, null)], { reconcileMode: "already" });
	try {
		await probe(m);
		expect(m.posts.length).toBe(1);
	} finally {
		m.server.stop(true);
	}
});

test("gate refusal of a possibly-live receipt refuses the restart", async () => {
	const m = startDrainMock([row(1, T1, null)], { reconcileMode: "refuse" });
	try {
		await expect(probe(m)).rejects.toThrow("not drained");
	} finally {
		m.server.stop(true);
	}
});

test("reconcile POST failure refuses the restart", async () => {
	const m = startDrainMock([row(1, T1, null)]);
	try {
		await expect(probe(m)).rejects.toThrow("not drained");
	} finally {
		m.server.stop(true);
	}
});

test("reconcile POST network failure refuses the restart", async () => {
	const m = startDrainMock([row(1, T1, null)], { reconcileMode: "netfail" });
	try {
		await expect(probe(m)).rejects.toThrow("not drained");
	} finally {
		m.server.stop(true);
	}
});

test("saturated lane paginates to complete coverage and passes", async () => {
	const m = startDrainMock([
		...spread(500, Date.parse(T1), 1),
		...spread(3, Date.parse(T1) - 600_000, 501),
	]);
	try {
		await probe(m);
		expect(m.queries.length).toBe(2);
		expect(m.queries[0]?.get("until")).toBe(null);
		expect(m.queries[1]?.get("until")).toBe(
			new Date(Date.parse(T1) - 498).toISOString(),
		);
	} finally {
		m.server.stop(true);
	}
});

test("page budget exhaustion refuses coverage-unknown", async () => {
	const m = startDrainMock(spread(4200, Date.parse(T1), 1));
	try {
		await expect(probe(m)).rejects.toThrow("coverage is unknown");
		expect(m.queries.length).toBe(8);
	} finally {
		m.server.stop(true);
	}
});

test("same-millisecond group larger than a page refuses coverage-unknown", async () => {
	const m = startDrainMock(
		Array.from({ length: 505 }, (_, i) => row(i + 1, T1, 200)),
	);
	try {
		await expect(probe(m)).rejects.toThrow("coverage is unknown");
	} finally {
		m.server.stop(true);
	}
});

test("foreign-lane row refuses coverage-unknown (exact-lane guard intact)", async () => {
	const m = startDrainMock([
		row(1, T1, 200),
		{ ...row(2, T0, 200), lane: "unrelated-lane" },
	]);
	try {
		await expect(probe(m)).rejects.toThrow("coverage is unknown");
	} finally {
		m.server.stop(true);
	}
});

test("failed read refuses coverage-unknown", async () => {
	const m = startDrainMock([row(1, T1, 200)], { readFail: true });
	try {
		await expect(probe(m)).rejects.toThrow("coverage is unknown");
	} finally {
		m.server.stop(true);
	}
});
