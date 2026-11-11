// deploy/phase0-testbed/verify.ts — the Phase 0 smoke orchestrator: runs the
// REAL chain (host → caddy → gate-edge → gate-inner → stub) from inside the
// rehearsal network and exits nonzero on any failed check. The host-side h3
// probe (brew curl --http3-only against :8443) runs OUTSIDE this script —
// in-container curl images have no h3 client.

const EDGE = "http://gate-edge:4101";
const STUB_LOG = "http://stub:8191/__log";
const root = process.env.EDGE_ROOT_KEY;
if (!root) {
	console.error("verify: EDGE_ROOT_KEY missing");
	process.exit(2);
}

let passed = 0;
const ok = (name: string, cond: unknown, detail = ""): void => {
	if (!cond) {
		console.error(`verify: FAIL ${name} ${detail}`);
		process.exit(1);
	}
	passed++;
	console.log(`verify: ok ${name}`);
};

// 1. gate up
let health = 503;
for (let i = 0; i < 60 && health !== 200; i++) {
	await new Promise((r) => setTimeout(r, 500));
	health = await fetch(`${EDGE}/health`).then((r) => r.status).catch(() => 503);
}
ok("edge /health 200", health === 200);

// 2. mint a lane key (admin API: 201 {key_id, key})
const mint = await fetch(`${EDGE}/v1/admin/keys`, {
	method: "POST",
	headers: { authorization: `Bearer ${root}`, "content-type": "application/json" },
	body: JSON.stringify({ name: "phase0-verify", scopes: ["buckle:proxy:WRITE_"] }),
});
ok("mint 201", mint.status === 201, String(mint.status));
const laneKey = (await mint.json()).key as string;

// 3. JSON completion through the FULL chain (client trace id → round-trip)
const tid = "c".repeat(32);
const comp = await fetch(`${EDGE}/v1/chat/completions`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${laneKey}`,
		"content-type": "application/json",
		traceparent: `00-${tid}-${"d".repeat(16)}-01`,
	},
	body: JSON.stringify({
		model: "test-model",
		messages: [{ role: "user", content: "smoke" }],
	}),
});
ok("chain 200", comp.status === 200, String(comp.status));
ok("hop annotations return", comp.headers.get("x-klh-trace-id") === tid);
const body = (await comp.json()) as { choices: { message: { content: string } }[] };
ok("stub-ok content", body.choices?.[0]?.message?.content === "stub-ok");

// 4. SSE + include_usage through the chain
const sse = await fetch(`${EDGE}/v1/chat/completions`, {
	method: "POST",
	headers: {
		authorization: `Bearer ${laneKey}`,
		"content-type": "application/json",
	},
	body: JSON.stringify({
		model: "test-model",
		messages: [{ role: "user", content: "smoke-stream" }],
		stream: true,
		stream_options: { include_usage: true },
	}),
});
ok("sse 200", sse.status === 200);
ok("sse mime", (sse.headers.get("content-type") ?? "").includes("text/event-stream"));
const text = await sse.text();
ok("terminal usage frame", /"choices":\[\].*"usage"/.test(text.replace(/\n/g, "")));

// 5. denied admission at the edge
const denied = await fetch(`${EDGE}/v1/chat/completions`, {
	method: "POST",
	headers: { authorization: "Bearer bk_wrong", "content-type": "application/json" },
	body: JSON.stringify({ model: "test-model", messages: [] }),
});
ok("401 denied", denied.status === 401, String(denied.status));

// 6. stub journal: the SAME trace id reached the END of the chain (the
// JSON completion carries the client traceparent; SSE/401 legs don't —
// match the propagated entry, not the last one)
const log = (await fetch(STUB_LOG).then((r) => r.json())) as {
	entries: { traceId: string | null; keyFp: string; path: string }[];
};
const hit = log.entries.find(
	(e) => e.path === "/v1/chat/completions" && e.traceId === tid,
);
ok("trace propagated end-to-end", hit !== undefined);
ok("keyFp 16hex", /^[0-9a-f]{16}$/.test(hit?.keyFp ?? ""));

console.log(`PHASE0_SMOKE_OK ${passed} checks`);
