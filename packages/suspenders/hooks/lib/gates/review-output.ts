import { z } from "zod";

export const ReviewFailureKindSchema = z.enum([
	"review-output",
	"provider",
	"unknown",
]);
export type ReviewFailureKind = z.infer<typeof ReviewFailureKindSchema>;

/** A known HTTP-success response that cannot supply a review; never provider pressure. */
export class ReviewOutputError extends Error {
	constructor(
		message: string,
		readonly text?: string,
	) {
		super(message);
	}
}

const ReviewVerdictLineSchema = z
	.string()
	.regex(/^VERDICT: (?:PASS(?: - \S.*)?|FAIL - \S.*)$/);

/** Only a complete final, unfenced line decides the verdict. Earlier findings remain separate. */
export function terminalReviewVerdict(text: string | null): string | undefined {
	if (!text) return undefined;
	const lines = text.trimEnd().split("\n");
	let fence: string | undefined;
	for (const line of lines.slice(0, -1)) {
		const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
		if (!marker) continue;
		if (!fence) fence = marker;
		else if (
			/^ {0,3}(`{3,}|~{3,})[ \t]*$/.test(line) &&
			marker[0] === fence[0] &&
			marker.length >= fence.length
		)
			fence = undefined;
	}
	if (fence) return undefined;
	const last = lines.at(-1);
	if (!last || !/^ {0,3}VERDICT: /.test(last)) return undefined;
	const final = last.trim();
	return ReviewVerdictLineSchema.safeParse(final).success
		? final?.slice("VERDICT: ".length)
		: undefined;
}
