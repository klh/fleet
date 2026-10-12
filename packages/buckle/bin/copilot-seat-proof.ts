// bin/copilot-seat-proof.ts — W695.6.2 live proof: a lane-shaped /v1/messages
// request WITH tools rides an in-process buckle onto the REAL GitHub Copilot
// seat (the claude-* groups in the machine upstreams.yaml). Run after the seat
// quota lifts (~2026-11-01) and the pinned-cloud gate ruling lands — until then
// the must-hint leg 429s into the retry-after floor and the pinned leg
// no_routes at attempts=0 (finding.w695.6.2). Secrets (root key, PAT) stay
// inside this process and are never printed. PASS = a tool_use block comes
// back through the full stack.
import { readFileSync } from "node:fs";
import { resolvePort, startServer } from "../src/server.ts";

const LLM = `${process.env.HOME}/.claude/local-llm`;
const PORT = resolvePort(4104);
const rootKey = `bkroot_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.BUCKLE_ROOT_KEY = rootKey;
process.env.GITHUB_COPILOT_PAT = readFileSync(
	`${LLM}/copilot.key`,
	"utf8",
).trim();

const server = startServer({
	port: PORT,
	upstreamsPath: process.env.BUCKLE_UPSTREAMS ?? `${LLM}/upstreams.yaml`,
	dbPath: `/tmp/buckle-copilot-proof-${Date.now()}.db`,
	auth: { rootKey },
});
const base = `http://127.0.0.1:${server.port}`;
console.log(`buckle up on :${server.port} (root keyed)`);

const mintRes = await fetch(`${base}/v1/admin/keys`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		authorization: `Bearer ${rootKey}`,
	},
	body: JSON.stringify({
		name: "copilot-seat-proof",
		scopes: ["buckle:proxy:WRITE_"],
	}),
});
const mint = await mintRes.json();
const keyId = (mint.id ?? mint.key_id) as string | undefined;
const laneKey = (mint.key ?? mint.token ?? mint.secret) as string | undefined;
if (mintRes.status !== 201 && mintRes.status !== 200) {
	console.log(
		`mint failed: ${mintRes.status} ${JSON.stringify(mint).slice(0, 300)}`,
	);
	process.exit(1);
}
console.log(`lane key minted id=${keyId}`);

const res = await fetch(`${base}/v1/messages`, {
	method: "POST",
	headers: {
		"content-type": "application/json",
		"x-api-key": laneKey ?? "",
		authorization: `Bearer ${laneKey ?? ""}`,
		"anthropic-version": "2023-06-01",
		// must cloud: the only leg that reaches a cloud-only group without the
		// pinned-gate ruling (a pinned explicit-model call refuses at attempts=0)
		"x-belt-hint": "must cloud",
	},
	body: JSON.stringify({
		model: "claude-sonnet-5",
		max_tokens: 300,
		tools: [
			{
				name: "get_weather",
				description: "Get current weather for a city",
				input_schema: {
					type: "object",
					properties: { city: { type: "string" } },
					required: ["city"],
				},
			},
		],
		messages: [
			{
				role: "user",
				content: "Call get_weather for Copenhagen. Call the tool; no prose.",
			},
		],
	}),
	// bounded: an upstream quota wall must not park the caller for the
	// provider's full retry-after (the uncapped-floor hazard, W695.6.1)
	signal: AbortSignal.timeout(240_000),
}).catch((e) => {
	console.log(`client fetch error: ${String(e).slice(0, 200)}`);
	return null;
});
if (!res) {
	if (keyId) {
		await fetch(`${base}/v1/admin/keys/${keyId}/revoke`, {
			method: "POST",
			headers: { authorization: `Bearer ${rootKey}` },
		}).catch(() => {});
	}
	process.exit(1);
}
const out = await res.text();
let verdict = "FAIL";
try {
	const j = JSON.parse(out);
	const tu = (j.content ?? []).find(
		(c: { type: string }) => c.type === "tool_use",
	);
	if (res.status === 200 && tu) {
		verdict = "PASS";
		console.log(
			`tool_use: name=${tu.name} input=${JSON.stringify(tu.input)} stop=${j.stop_reason} model=${j.model}`,
		);
		console.log(`usage: ${JSON.stringify(j.usage)}`);
	} else {
		console.log(`status=${res.status} body=${out.slice(0, 500)}`);
	}
} catch {
	console.log(`non-JSON: ${out.slice(0, 300)}`);
}
if (keyId) {
	await fetch(`${base}/v1/admin/keys/${keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${rootKey}` },
	}).catch(() => {});
}
console.log(
	`VERDICT: ${verdict} — buckle :${server.port} → Copilot seat, lane-shaped /v1/messages+tools`,
);
process.exit(verdict === "PASS" ? 0 : 1);
