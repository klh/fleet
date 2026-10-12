// deploy/e2e/lane-executor.ts — the stub lane executor for the dispatch
// probe (W234). dispatch-next spawns it with the lane env it pinned
// (ANTHROPIC_BASE_URL = <hub>/w/<sid>, ANTHROPIC_AUTH_TOKEN = the hub-minted
// bksk_ key); the executor routes ONE real chat through that front and
// writes the evidence the runner asserts on. Then it stays alive past the
// dispatch liveness check and exits by itself (no orphan lanes).
//
// Evidence (single JSON object on one file):
//   { ts, base, hub, model, status, ok, sample, latency_ms, pid }
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const BASE = process.env.ANTHROPIC_BASE_URL ?? "";
const TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? "";
const MODEL = process.env.LANE_MODEL ?? "glm-5.3-flash";
const EVIDENCE = process.env.KLH_LANE_EVIDENCE ?? "";

interface Evidence {
	ts: string;
	base: string;
	hub: string | null;
	model: string;
	status: number;
	ok: boolean;
	sample: string;
	latency_ms: number;
	pid: number;
}

async function chat(): Promise<Evidence> {
	const t0 = Date.now();
	let status = 0;
	let sample = "";
	if (BASE.length === 0 || TOKEN.length === 0) {
		sample = "missing ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN";
	} else {
		try {
			const res = await fetch(`${BASE}/v1/messages`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${TOKEN}`,
					"x-api-key": TOKEN,
				},
				body: JSON.stringify({
					model: MODEL,
					max_tokens: 16,
					stream: true,
					messages: [
						{ role: "user", content: "Reply with the single word: ok" },
					],
				}),
			});
			status = res.status;
			const text = await res.text();
			// anthropic SSE: the first content_block_delta carries the text —
			// grab any text_delta payload as the sample.
			const m = /"text_delta","text":"([^"]*)"/.exec(text);
			sample = m?.[1] ?? text.slice(0, 120);
		} catch (err) {
			sample = `fetch failed: ${String(err)}`;
		}
	}
	const ok = status === 200 && sample.includes("e2e-stub-ok");
	return {
		ts: new Date().toISOString(),
		base: BASE,
		hub: process.env.SUSPENDERS_HUB ?? null,
		model: MODEL,
		status,
		ok,
		sample,
		latency_ms: Date.now() - t0,
		pid: process.pid,
	};
}

const evidence = await chat();
if (EVIDENCE.length > 0) {
	mkdirSync(dirname(EVIDENCE), { recursive: true });
	writeFileSync(EVIDENCE, JSON.stringify(evidence));
}
console.log(
	`lane-executor: status=${evidence.status} ok=${String(evidence.ok)} sample=${evidence.sample}`,
);

// stay alive past the dispatch liveness check, then exit (self-reaping)
await Bun.sleep(45_000);
