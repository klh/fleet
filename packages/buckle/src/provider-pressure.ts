export type ProviderPressure = "concurrency" | "rate";

// W1257: a configured concurrency code alone cannot prove concurrency —
// Z.ai's 1302 says "Rate limit reached for requests" and collapsed the live
// spoke pool to 1/50. A configured code counts only when the provider's own
// message carries explicit concurrency evidence ("concurrent/concurrency").
export const EXPLICIT_CONCURRENCY_EVIDENCE = /\bconcurr(?:ent|ency|ing)\b/i;

export const providerPressureOf = (
	policy: { concurrencyErrorCodes?: string[] } | undefined,
	code: string | number | null,
	message = "",
): ProviderPressure =>
	code !== null &&
	EXPLICIT_CONCURRENCY_EVIDENCE.test(message) &&
	policy?.concurrencyErrorCodes?.includes(String(code))
		? "concurrency"
		: "rate";

export function assertProviderConcurrencyErrorCodes(
	value: unknown,
): asserts value is string[] {
	if (
		!Array.isArray(value) ||
		value.length > 16 ||
		new Set(value).size !== value.length ||
		value.some(
			(code) =>
				typeof code !== "string" || !/^[A-Za-z0-9_.:-]{1,64}$/.test(code),
		)
	)
		throw new Error(
			"Provider concurrency error codes must be at most sixteen unique bounded tokens",
		);
}
