// test/helpers/pressure-proxy.ts — W1173.1.1: a loopback forward proxy in
// front of a real store server that refuses exactly one SQL statement (the
// immutable completion-record lookup) with a chosen pressure flavor. Spawned
// as `bun pressure-proxy.ts <port> <upstream> <flavor>`: the test's
// HttpGovernorStore curls the PROXY, and the proxy fetches the real server —
// child→child loopback, which works where a curl into a parent-process
// Bun.serve hangs on this macOS (see consult-federation hub-wire tests).
const port = Number(process.argv[2]);
const upstream = process.argv[3];
const flavor = process.argv[4] === "busy" ? "busy" : "http503";

Bun.serve({
	port,
	extendedIdleTimeout: true,
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/health") return new Response("ok");
		const raw = await req.text();
		let sql = "";
		try {
			sql = String((JSON.parse(raw) as { sql?: unknown }).sql ?? "");
		} catch {}
		// only the record lookup is pressured; everything else forwards verbatim
		// (begin/rollback/other reads ride the real server for real)
		if (sql.includes("FROM work_completion_records")) {
			if (flavor === "busy")
				return Response.json({
					err: "database is locked",
					code: "store_sql_fail",
					sqlite_code: "SQLITE_BUSY",
					executed: "unknown",
				});
			return new Response("store under pressure", { status: 503 });
		}
		return fetch(`${upstream}${url.pathname}`, {
			method: req.method,
			headers: req.headers,
			body: raw,
		});
	},
});
