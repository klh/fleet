import { stripVTControlCharacters } from "node:util";
import { BUILTIN_RULES, redactMatches } from "../../hooks/lib/gates/scrub.ts";
import { redactSecrets } from "../../hooks/lib/knowledge/secret-redaction.ts";

const credentialRules = BUILTIN_RULES.filter((rule) =>
	/key|token/.test(rule.name),
);
export const secretText = (text: string): string =>
	redactMatches(redactSecrets(text).text, credentialRules);
/** One terminal line; provider prose cannot inject terminal escapes or new rows. */
export const plain = (text: string): string =>
	stripVTControlCharacters(secretText(text)).replace(/\p{Cc}/gu, " ");
export function safeUrl(raw: string | null): string {
	try {
		const url = new URL(raw ?? "");
		return ["http:", "https:"].includes(url.protocol) ? url.origin : "unknown";
	} catch {
		return "unknown";
	}
}

export function cleanValue(value: unknown): unknown {
	if (typeof value === "string")
		return secretText(stripVTControlCharacters(value));
	if (Array.isArray(value)) return value.map(cleanValue);
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, cleanValue(entry)]),
		);
	return value;
}
