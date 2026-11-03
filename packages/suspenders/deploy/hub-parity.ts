// deploy/hub-parity.ts — W2595 cross-hub same-body parity probe matrix.
//
// The owner law is "all hubs ARE THE SAME": one request body must get the
// same field-acceptance verdict through EVERY hub's buckle gate for the
// same model family. The 2026-11-03 incident was exactly a parity hole —
// the Mac's litellm drop_params net never saw hub copilot traffic, so
// thinking/reasoning_effort 400'd on one hub while its twin passed.
//
// One matrix row = one probe body × one hub. Each probe mints a 120s
// lane key ON the hub (root credential + mint stay on the device — the
// same interface as mint-lane-key), POSTs the hub's own /v1/messages
// with that key, and classifies the answer:
//   2xx        → pass (fields accepted or safely dropped)
//   400/422    → strip (fields rejected — fine if every hub strips)
//   401/403    → error (probe credential invalid — never a parity verdict)
// Parity = identical verdict sets across hubs per probe. The verb prints
// the matrix and exits non-zero when verdicts diverge.

import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** The probe bodies: the W2594 deny-list fields the direct Copilot wire
 *  400s but litellm drop_params eats. Same body on every hub, every run. */
export interface ParityProbe {
	id: string;
	body: Record<string, unknown>;
}

export const PARITY_PROBES: ParityProbe[] = [
	{
		id: "copilot-claude+denylist",
		body: {
			model: "claude-sonnet-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "Say ok" }],
			thinking: { type: "enabled", budget_tokens: 1024 },
			reasoning_effort: "low",
		},
	},
	{
		id: "copilot-claude-clean",
		body: {
			model: "claude-sonnet-5",
			max_tokens: 16,
			messages: [{ role: "user", content: "Say ok" }],
		},
	},
];

export type ParityVerdict = "pass" | "strip" | "error" | "unreachable";

/** Classify one probe answer: 2xx pass · 400/422 body-field rejection
 *  strip · 401/403 probe-credential error · anything else error. */
export function classifyParityAnswer(status: number): ParityVerdict {
	if (status >= 200 && status < 300) return "pass";
	if (status === 400 || status === 422) return "strip";
	return "error";
}

export interface ParityRow {
	hub: string;
	probe: string;
	verdict: ParityVerdict;
	detail?: string;
}

export function parityMatrix(
	hub: HubProfile,
	hubName: string,
	probe: (body: Record<string, unknown>) => number,
): ParityRow[] {
	const port = hub.buckle_port;
	const root = hub.secrets?.buckle_root_key;
	if (!port || !root) {
		return PARITY_PROBES.map((p) => ({
			hub: hubName,
			probe: p.id,
			verdict: "error",
			detail: "hub needs buckle_port + secrets.buckle_root_key",
		}));
	}
	return PARITY_PROBES.map((p) => {
		const status = probe(p.body);
		return {
			hub: hubName,
			probe: p.id,
			verdict: classifyParityAnswer(status),
			detail: `HTTP ${status}`,
		};
	});
}

/** Parity holds when every probe id has ONE verdict class across all hubs
 *  (error/unreachable rows are excluded — they carry no parity signal). */
export function parityDiverges(rows: ParityRow[]): boolean {
	const byProbe = new Map<string, Set<ParityVerdict>>();
	for (const r of rows) {
		if (r.verdict === "error" || r.verdict === "unreachable") continue;
		const set = byProbe.get(r.probe) ?? new Set<ParityVerdict>();
		set.add(r.verdict);
		byProbe.set(r.probe, set);
	}
	return [...byProbe.values()].some((set) => set.size > 1);
}

export function renderParityMatrix(rows: ParityRow[]): string {
	const glyphs: Record<ParityVerdict, string> = {
		pass: "✓",
		strip: "−",
		error: "✗",
		unreachable: "?",
	};
	const lines = rows.map(
		(r) =>
			`${glyphs[r.verdict]} ${r.hub} ${r.probe} → ${r.verdict}${r.detail ? ` (${r.detail})` : ""}`,
	);
	if (parityDiverges(rows))
		lines.push(
			"PARITY DIVERGENCE — the same body must get the same verdict on every hub",
		);
	return lines.join("\n");
}
