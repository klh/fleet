// review-parse.ts — W792: parse machine-parseable lines out of reviewer,
// hunter, verifier and triage model output. Lenient on prose, strict on the
// extracted fields; everything unparsable is dropped and counted.
import type { Finding, Severity } from "./review-core.ts";

const SEVERITIES: Severity[] = ["high", "medium", "low"];
const isSev = (s: string): s is Severity => SEVERITIES.includes(s as Severity);

/** Finding line contract (matches the oracle.ts review/bugs frame):
 *  `severity(high|medium|low): path:line — issue` or
 *  `file:line — issue — severity` variants; prose lines are dropped. */
export function parseFindings(text: string, cap = 30): Finding[] {
	const out: Finding[] = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("```")) continue;
		let m = /^(high|medium|low)[:\s]+([^\s:]+):(\d+)\s*[—–-]+\s*(.+)$/i.exec(line);
		if (!m) {
			// fallback: `path:line — issue` (severity inferred low → medium)
			m = /^([^\s:]+):(\d+)\s*[—–-]+\s*(.+)$/.exec(line);
			if (!m) continue;
			const issue = m[3] ?? "";
			if (issue.length < 8) continue; // too short to be a real finding
			out.push({
				severity: "medium",
				file: m[1] ?? "",
				line: Number(m[2]),
				issue: issue.slice(0, 200),
			});
			if (out.length >= cap) break;
			continue;
		}
		const sev = (m[1] ?? "").toLowerCase();
		const issue = m[4] ?? "";
		if (issue.length < 8) continue;
		out.push({
			severity: isSev(sev) ? sev : "medium",
			file: m[2] ?? "",
			line: Number(m[3]),
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
	return { verdict: "FAIL", reason: "no verdict line (empty verdict is a fail)" };
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
		const m = /^(\d{1,2})\s*[:.)-]?\s*(important|nit|pre-existing|preexisting)\b/i.exec(
			raw.trim(),
		);
		if (!m) continue;
		const i = Number(m[1]) - 1;
		const k = (m[2] ?? "").toLowerCase().replace("preexisting", "pre-existing");
		if (i >= 0 && i < n)
			out[i] = k === "nit" ? "nit" : k === "pre-existing" ? "pre-existing" : "important";
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
