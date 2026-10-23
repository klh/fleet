export type ProviderPressure = "concurrency" | "rate";
export const providerPressureOf = (
	policy: { concurrencyErrorCodes?: string[] } | undefined,
	code: string | number | null,
): ProviderPressure =>
	code !== null && policy?.concurrencyErrorCodes?.includes(String(code))
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
