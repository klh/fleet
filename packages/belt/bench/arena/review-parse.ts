// review-parse.ts — W792/W832: parse machine-parseable lines out of reviewer,
// hunter, verifier and triage model output. Lenient on prose, strict on the
// extracted fields; everything unparsable is dropped and counted. W832 adds
// the stable finding IDs (B<round>-<slug> / N<round>-<slug>) and the
// cross-round acknowledgement statuses (fixed | still-open | not-verifiable).
// W792 lesson: reviewer vocabulary drifts per request — aliases map into the
// canonical set, and ONLY an explicit "fixed" closes a finding.
import type { Finding } from "./review-core.ts";

/** Finding line contract (matches the oracle.ts review/bugs frame):
 *  `severity(high|medium|low): path:line — issue` or
 *  `file:line — issue — severity` variants; prose lines are dropped. */
/** severity aliases the reviewer tiers actually emit → canonical Severity. */
const SEV_ALIAS: Record<string, "high" | "medium" | "low"> = {
	critical: "high",
	blocker: "high",
	note: "low",
	high: "high",
	major: "high",
	medium: "medium",
	med: "medium",
	moderate: "medium",
	low: "low",
	minor: "low",
};

/** Finding-line shape: [bullet][bold][ID][:space/(] severity [:space/(] file:line — issue.
 *  Group 1 = the optional W832 stable ID, case-insensitively. */
const FINDING_RE =
	/^(?:[-*•]\s*)?(?:\*\*)?(?:([BN]\d{1,2}-[a-z0-9][a-z0-9-]*)\s*[:.)-]+\s*)?(?:severity\s*)?\(?(critical|high|major|medium|med|moderate|low|minor|blocker|note)\)?[:\s(]+([^\s:(]+):(\d+)\s*[—–-]+\s*(.+)$/i;

/** Ack line contract (W832): `B1-slug: fixed — what was re-run`. The status
 *  slot takes the canonical three plus drift aliases; anything unrecognized
 *  normalizes to still-open — only an explicit "fixed" closes. */
const ACK_RE =
	/^(?:[-*•]\s*)?(?:\*\*)?\(?([BN]\d{1,2}-[a-z0-9][a-z0-9-]*)\)?\s*[:.)-]+\s*\*{0,2}(fixed|still[- ]open|open|unfixed|not[- ]verifiable|unverifiable|resolved|closed)\*{0,2}\s*(?:[—–:-]+\s*(.*))?$/i;

const ACK_ALIAS: Record<string, "fixed" | "still-open" | "not-verifiable"> = {
	fixed: "fixed",
	"still-open": "still-open",
	"still open": "still-open",
	open: "still-open",
	unfixed: "still-open",
	"not-verifiable": "not-verifiable",
	"not verifiable": "not-verifiable",
	unverifiable: "not-verifiable",
	// only an explicit "fixed" closes — resolved/closed drift stays open
	resolved: "still-open",
	closed: "still-open",
};

export function parseFindings(text: string, cap = 30): Finding[] {
	const out: Finding[] = [];
	for (const raw of text.split("\n")) {
		const line = raw
			.trim()
			.replace(/^[-*•]\s*/, "") // markdown bullets
			.replace(/\*\*/g, ""); // bold
		if (!line || line.startsWith("```")) continue;
		let m = FINDING_RE.exec(line);
		if (!m) {
			// fallback: `[B1-slug: ]path:line — issue` (severity inferred medium)
			m =
				/^(?:([BN]\d{1,2}-[a-z0-9][a-z0-9-]*)\s*[:.)-]+\s*)?([^\s:(]+):(\d+)\s*[—–-]+\s*(.+)$/.exec(
					line,
				);
			if (!m) continue;
			const issue = m[4] ?? "";
			if (issue.length < 8) continue; // too short to be a real finding
			out.push({
				id: m[1] ?? null,
				severity: "medium",
				file: m[2] ?? "",
				line: Number(m[3]),
				issue: issue.slice(0, 200),
			});
			if (out.length >= cap) break;
			continue;
		}
		const sev = (m[2] ?? "").toLowerCase();
		const issue = m[5] ?? "";
		if (issue.length < 8) continue;
		out.push({
			id: m[1] ?? null,
			severity: SEV_ALIAS[sev] ?? "medium",
			file: m[3] ?? "",
			line: Number(m[4]),
			issue: issue.slice(0, 200),
		});
		if (out.length >= cap) break;
	}
	return out;
}

/** Final-line verdict: `VERDICT: PASS` | `VERDICT: FAIL - <reason>`. */
export function parseVerdictLine(text: string): {
	verdict: "PASS" | "FAIL";
	reason: string;
} {
	const lines = text.trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const m = /^\*{0,2}VERDICT:\s*(PASS|FAIL)\*{0,2}\s*(?:[-–]\s*(.*))?$/i.exec(
			(lines[i] ?? "").trim(),
		);
		if (m)
			return {
				verdict: (m[1] ?? "").toUpperCase() === "PASS" ? "PASS" : "FAIL",
				reason: (m[2] ?? "").slice(0, 200),
			};
	}
	return {
		verdict: "FAIL",
		reason: "no verdict line (empty verdict is a fail)",
	};
}

// ---------------------------------------------------------------- acknowledgements (W832)
export type AckStatus = "fixed" | "still-open" | "not-verifiable";
export interface Ack {
	id: string;
	status: AckStatus;
	rerun: string;
}

/** Ack statuses + aliases the reviewer tiers actually emit → the canonical
 *  three. Unrecognized statuses normalize to still-open (fail-safe). */
export function normalizeAckStatus(word: string): AckStatus {
	return ACK_ALIAS[word.toLowerCase().replace(/\s+/g, "-")] ?? "still-open";
}

/** One `<ID>: <status> — what was re-run` line per acknowledged prior finding.
 *  First ack line per ID wins (deterministic); unknown IDs are kept — the
 *  caller matches against its own prior-ID list. */
export function parseAcks(text: string): Ack[] {
	const out: Ack[] = [];
	const seen = new Set<string>();
	for (const raw of text.split("\n")) {
		const line = raw
			.trim()
			.replace(/^[-*•]\s*/, "")
			.replace(/\*\*/g, "");
		if (!line || line.startsWith("```")) continue;
		const m = ACK_RE.exec(line);
		if (!m) continue;
		const id = (m[1] ?? "").toLowerCase();
		if (!id || seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			status: normalizeAckStatus(m[2] ?? ""),
			rerun: (m[3] ?? "").slice(0, 200),
		});
	}
	return out;
}

/** W832 closure rule: only an explicit "fixed" closes; a missing ack line
 *  stays open. Returns the prior BLOCKER (B-*) IDs still open — notes never
 *  force the FAIL. */
export function openPriorBlockers(priorIds: string[], acks: Ack[]): string[] {
	const ack = new Map(acks.map((a) => [a.id, a] as const));
	return priorIds.filter((id) => {
		const hit = ack.get(id.toLowerCase());
		return /^b/i.test(id) && hit?.status !== "fixed";
	});
}

// ---------------------------------------------------------------- stable IDs (W832)
/** kebab slug from the issue head — the <slug> half of a stable ID. */
export function slugOf(issue: string): string {
	const slug = issue
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(/\s+/)
		.slice(0, 3)
		.join("-");
	return slug === "" ? "finding" : slug;
}

/** Synthesize a stable ID for an unprefixed finding: `B<round>-<slug>` when
 *  blocker-class, else `N<round>-<slug>`; seq > 0 disambiguates collisions. */
export function findingIdOf(
	round: number,
	blocker: boolean,
	issue: string,
	seq = 0,
): string {
	return `${blocker ? "B" : "N"}${round}-${slugOf(issue)}${seq > 0 ? `-${seq}` : ""}`;
}

export type VerifyKind = "confirmed" | "refuted" | "unclear";
/** Verifier reply contract: one `N: confirmed|refuted|unclear — note` line
 *  per finding, in order. Missing entries = unclear. */
export function parseVerify(text: string, n: number): VerifyKind[] {
	const out: VerifyKind[] = Array.from({ length: n }, () => "unclear");
	for (const raw of text.split("\n")) {
		const m = /^(\d{1,2})\s*[:.)-]?\s*(confirmed|refuted|unclear)\b/i.exec(
			raw.trim(),
		);
		if (!m) continue;
		const i = Number(m[1]) - 1;
		const kind = (m[2] ?? "").toLowerCase() as VerifyKind;
		if (i >= 0 && i < n) out[i] = kind;
	}
	return out;
}

export type TriageKind = "important" | "nit" | "pre-existing";
/** Triage reply contract: one `N: important|nit|pre-existing` line per finding. */
export function parseTriage(text: string, n: number): TriageKind[] {
	const out: TriageKind[] = Array.from({ length: n }, () => "important");
	for (const raw of text.split("\n")) {
		const m =
			/^(\d{1,2})\s*[:.)-]?\s*(important|nit|pre-existing|preexisting)\b/i.exec(
				raw.trim(),
			);
		if (!m) continue;
		const i = Number(m[1]) - 1;
		const k = (m[2] ?? "").toLowerCase().replace("preexisting", "pre-existing");
		if (i >= 0 && i < n)
			out[i] =
				k === "nit"
					? "nit"
					: k === "pre-existing"
						? "pre-existing"
						: "important";
	}
	return out;
}

/** Fixer reply: a fenced code block with the corrected full file. */
export function parseFix(text: string): string | null {
	const fence = /```(?:[a-z]*)\n([\s\S]*?)```/.exec(text);
	if (!fence) return null;
	const body = fence[1] ?? "";
	return body.length > 20 ? body.replace(/\n$/, "") : null;
}
