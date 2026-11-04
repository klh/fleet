// test/fixtures/kev-stub.ts — out-of-process kev-class systemone stub. Suites
// that drive the CLI through Bun.spawnSync cannot be answered by an
// in-process serve (the parent's event loop is blocked), so they spawn this.
// Answers every typed decision with KEV_STUB_CHOICE (default "store") at
// confidence 0.9; prints the bound port on stdout, then serves until killed.
const choice = process.env.KEV_STUB_CHOICE ?? "store";
const server = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch: () =>
		Response.json({
			model: "kev-stub",
			answers: {
				d: {
					type: "choice",
					choice,
					confidence: 0.9,
					probabilities: { [choice]: 0.9 },
				},
			},
			usage: { input_tokens: 1, output_tokens: 1 },
			latency_ms: 1,
		}),
});
console.log(server.port);
// a caller may pin the port report to a file (playwright workers swallow
// child stdout — the env-named file is the reliable channel)
if (process.env.KEV_STUB_PORT_FILE)
	await Bun.write(process.env.KEV_STUB_PORT_FILE, `${server.port}`);
