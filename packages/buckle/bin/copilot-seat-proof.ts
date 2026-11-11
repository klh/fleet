// bin/copilot-seat-proof.ts — W695.6.2 live proof: a lane-shaped /v1/messages
// request WITH tools rides an in-process buckle onto the REAL GitHub Copilot
// seat (the claude-* groups in the machine upstreams.json). Run after the seat
// quota lifts (~2026-11-01) and the pinned-cloud gate ruling lands — until then
// the must-hint leg 429s into the retry-after floor and the pinned leg
// no_routes at attempts=0 (finding.w695.6.2). Secrets (root key, PAT) stay
// inside this process and are never printed. PASS = a tool_use block comes
// back through the full stack.

// W1124.8.4: the Copilot PAT resolves via src/copilot-pat.ts (W2868: single
// shared resolver — env, then the CENTRAL provider profile bound to
// GITHUB_COPILOT_PAT; the implicit copilot.key file read is retired). The
// secret stays inside this process and is never printed.
import { resolvePort, startServer } from "../src/server.ts";
import {
	COPILOT_PAT_MISSING_MSG,
	resolveCopilotPat,
} from "../src/copilot-pat.ts";

// W2868: --pinned adds the NEED_DECISION #48672 evidence leg — a HINTLESS
// pinned explicit-model call (no x-belt-hint), which the W209 escalation gate
// refuses at attempts=0 for an all-cloud pinned group. PASS = the refusal is
// captured and classified (gate closed as expected); a tool_use here means the
// gate is open/bypassed — the ruling landed. --pinned-only skips the must leg.
const args = process.argv.slice(2);
const PINNED = args.includes("--pinned");
const PINNED_ONLY = args.includes("--pinned-only");

const LLM = `${process.env.HOME}/.claude/local-llm`;
const PORT = resolvePort(4104);
const rootKey = `bkroot_${crypto.randomUUID().replaceAll("-", "")}`;
process.env.BUCKLE_ROOT_KEY = rootKey;
const pat = resolveCopilotPat();
if (!pat) {
	console.log(COPILOT_PAT_MISSING_MSG);
	process.exit(1);
}
process.env.GITHUB_COPILOT_PAT = pat;

const server = startServer({
	port: PORT,
	upstreamsPath: process.env.BUCKLE_UPSTREAMS ?? `${LLM}/upstreams.json`,
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

console.log(`lane key minted id=${keyId}`);

interface LegOutcome {
	label: string;
	hint: string | null;
	status: number | null;
	verdict: string;
	detail: string;
}
const legs: LegOutcome[] = [];

async function leg(label: string, hint: string | null): Promise<LegOutcome> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-api-key": laneKey ?? "",
		authorization: `Bearer ${laneKey ?? ""}`,
		"anthropic-version": "2023-06-01",
	};
	if (hint) headers["x-belt-hint"] = hint;
	const r = await fetch(`${base}/v1/messages`, {
		method: "POST",
		headers,
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
		console.log(`client fetch error (${label}): ${String(e).slice(0, 200)}`);
		return null;
	});
	const outcome: LegOutcome = {
		label,
		hint,
		status: r?.status ?? null,
		verdict: "FAIL",
		detail: "",
	};
	if (!r) {
		outcome.detail = "transport error";
	} else {
		const out = await r.text();
		try {
			const j = JSON.parse(out);
			const tu = (j.content ?? []).find(
				(c: { type: string }) => c.type === "tool_use",
			);
			if (r.status === 200 && tu) {
				outcome.verdict = "PASS";
				outcome.detail = `tool_use name=${tu.name} stop=${j.stop_reason} model=${j.model} usage=${JSON.stringify(j.usage)}`;
			} else if (
				r.status === 429 ||
				String(j?.error?.type ?? "").includes("rate_limit")
			) {
				outcome.verdict = "QUOTA";
				outcome.detail = `retry-after=${r.headers.get("retry-after") ?? "?"} ${out.slice(0, 200)}`;
			} else if (
				!hint &&
				/no_route|cloud_forbidden|no_healthy_fit|attempts|escalation/i.test(
					out,
				)
			) {
				// hintless pinned leg: the expected shape under NEED_DECISION
				// #48672 is a gate refusal (no_route / cloud_forbidden) at
				// attempts=0 — capturing it IS the evidence the ruling needs.
				outcome.verdict = "GATE_REFUSAL";
				outcome.detail = `gate closed as expected: ${out.slice(0, 300)}`;
			} else {
				outcome.detail = `status=${r.status} ${out.slice(0, 300)}`;
			}
		} catch {
			outcome.detail = `non-JSON: ${out.slice(0, 200)}`;
		}
	}
	console.log(
		`leg ${label} (hint=${hint ?? "none"}): ${outcome.verdict} status=${outcome.status} — ${outcome.detail.slice(0, 160)}`,
	);
	legs.push(outcome);
	return outcome;
}

if (!PINNED_ONLY) await leg("must-cloud", "must cloud");
if (PINNED || PINNED_ONLY) await leg("pinned-hintless", null);

if (keyId) {
	await fetch(`${base}/v1/admin/keys/${keyId}/revoke`, {
		method: "POST",
		headers: { authorization: `Bearer ${rootKey}` },
	}).catch(() => {});
}
const must = legs.find((l) => l.label === "must-cloud");
const pinned = legs.find((l) => l.label === "pinned-hintless");
const ok = PINNED_ONLY
	? (pinned?.verdict === "GATE_REFUSAL" || pinned?.verdict === "PASS")
	: must?.verdict === "PASS" &&
		(!PINNED || pinned?.verdict === "GATE_REFUSAL" || pinned?.verdict === "PASS");
console.log(
	`VERDICT: ${ok ? "PASS" : "FAIL"} — buckle :${server.port} → Copilot seat, lane-shaped /v1/messages+tools (legs: ${legs.map((l) => `${l.label}=${l.verdict}`).join(", ")})`,
);
process.exit(ok ? 0 : 1);
